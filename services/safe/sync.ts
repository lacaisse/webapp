// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress } from "viem";

import { prisma } from "@/services/db/prisma";

import { isOwnerChangeKind, recordExecuted, tryExecute } from "./proposals";
import { redactRpcKey } from "./redact";
import { describeSafeConfigDrift, findSafeExecution, readSafeConfig, readSafeState } from "./relayer";
import { lc, recoverSafeTxSigner, safeTxFromRow, sameAddress } from "./safe-tx";
import {
  confirmTransaction,
  isTxServiceEnabled,
  listPendingTransactions,
  proposeTransaction,
  type TxServiceMultisigTx,
} from "./tx-service";
import { isSafeError, type Address, type Hex, type SafeTxSummary } from "./types";

// Mirror a fund Safe's chain + Safe Transaction Service state into the DB:
// owners / threshold, confirmations made in Safe{Wallet}, transactions
// executed outside La Caisse, nonces consumed by another transaction. Then
// execute whatever now meets its threshold. Scoped like proposals.ts: the
// safe is loaded by (id, fundId) and every transaction through it.

const MIN_SYNC_INTERVAL_MS = 30 * 1000;
// A Safe has at most a handful of owners; a hostile or buggy tx-service answer
// with thousands of confirmations must not burn CPU on signature recovery
// (review S20).
const MAX_CONFIRMATIONS_PER_TX = 50;
const STALE_EXECUTING_MS = 10 * 60 * 1000;
const IDLE_RESYNC_MS = 60 * 60 * 1000;

function messageOf(e: unknown): string {
  if (isSafeError(e)) return redactRpcKey(`${e.code}: ${e.message}`);
  return redactRpcKey(e instanceof Error ? e.message : String(e));
}

type SyncResult = { synced: boolean; executed: number; errors: number };

export async function syncSafe(a: {
  fundId: string;
  safeId: string;
  force?: boolean;
}): Promise<SyncResult> {
  const idle: SyncResult = { synced: false, executed: 0, errors: 0 };
  const safe = await prisma.fundSafe.findFirst({
    where: { id: a.safeId, fundId: a.fundId },
    select: {
      id: true,
      fundId: true,
      chainId: true,
      address: true,
      status: true,
      lastSyncedAt: true,
      configWarning: true,
    },
  });
  if (!safe || safe.status !== "ACTIVE") return idle;
  if (
    !a.force &&
    safe.lastSyncedAt &&
    Date.now() - safe.lastSyncedAt.getTime() < MIN_SYNC_INTERVAL_MS
  ) {
    return idle;
  }

  const safeAddress = getAddress(safe.address);
  let state: Awaited<ReturnType<typeof readSafeState>>;
  try {
    state = await readSafeState({ chainId: safe.chainId, safeAddress });
    if (!state.deployed) throw new Error("Safe is not deployed on chain");
  } catch (e) {
    console.warn("[safe-sync] chain read failed", safe.id, messageOf(e));
    await prisma.fundSafe.updateMany({
      where: { id: safe.id, fundId: a.fundId },
      data: { errorMessage: `sync: ${messageOf(e)}` },
    });
    return { ...idle, errors: 1 };
  }

  // (1) owners + threshold
  await refreshOwners({ fundId: a.fundId, safeId: safe.id, owners: state.owners, threshold: state.threshold });

  // (1b) wiring: modules / guard / singleton / fallback handler (review S6).
  // Anything non-canonical is recorded on the Safe and stops the relayer
  // (tryExecute refuses while configWarning is set); a read failure leaves
  // the previous verdict in place and is reported like any sync problem.
  let configWarning: string | null | undefined;
  try {
    const config = await readSafeConfig({ chainId: safe.chainId, safeAddress });
    configWarning = describeSafeConfigDrift(safe.chainId, config);
    if (configWarning !== safe.configWarning) {
      if (configWarning) console.warn("[safe-sync] configuration drift", safe.id, configWarning);
      await prisma.fundSafe.updateMany({
        where: { id: safe.id, fundId: a.fundId },
        data: { configWarning },
      });
    }
  } catch (e) {
    console.warn("[safe-sync] config read failed", safe.id, messageOf(e));
  }
  const owners = await prisma.fundSafeOwner.findMany({
    where: { safeId: safe.id, removedAt: null, safe: { fundId: a.fundId } },
    select: { address: true },
  });
  const ownerSet = new Set(owners.map((o) => lc(o.address)));

  // The Transaction Service only matters when an owner signs outside La
  // Caisse: with team-only owners nothing external can ever arrive, so we
  // don't spend the API quota on it.
  const ownerRows = await prisma.fundSafeOwner.findMany({
    where: { safeId: safe.id, removedAt: null, safe: { fundId: a.fundId } },
    select: { kind: true },
  });
  const hasExternal = ownerRows.some((o) => o.kind === "EXTERNAL");
  const serviceOn = hasExternal && isTxServiceEnabled(safe.chainId);
  let errors = 0;
  let executed = 0;
  let ownersChanged = false;
  // What went wrong this pass, kept on the Safe (step 5) so the page can say
  // the sync is lagging instead of silently showing stale rows.
  const problems: string[] = [];
  if (configWarning === undefined) problems.push("configuration check failed");

  const txs = await prisma.fundSafeTransaction.findMany({
    where: {
      safeId: safe.id,
      safe: { fundId: a.fundId },
      status: { in: ["PENDING", "EXECUTING", "FAILED"] },
    },
    include: {
      signatures: { select: { ownerAddress: true, signature: true, source: true } },
    },
    orderBy: [{ nonce: "asc" }, { createdAt: "asc" }],
  });

  // One read for the whole Safe: its open proposals on the service, by hash.
  let remoteByHash = new Map<string, TxServiceMultisigTx>();
  if (serviceOn && txs.some((t) => t.status === "PENDING")) {
    try {
      const list = await listPendingTransactions({ chainId: safe.chainId, safeAddress });
      remoteByHash = new Map(list.map((r) => [lc(r.safeTxHash), r]));
    } catch (e) {
      console.warn("[safe-sync] tx-service list failed", safe.id, messageOf(e));
    }
  }

  const stillPending: { id: string; kind: (typeof txs)[number]["kind"] }[] = [];

  for (const tx of txs) {
    // (2) The nonce moved past this transaction. Either it executed (ours
    // with lost bookkeeping, or an owner ran it from Safe{Wallet}) or another
    // transaction consumed the nonce. The Safe's own ExecutionSuccess /
    // ExecutionFailure event, indexed by safeTxHash, tells which — no
    // Transaction Service needed.
    if (state.nonce > tx.nonce) {
      let seen: Awaited<ReturnType<typeof findSafeExecution>> = null;
      try {
        seen = await findSafeExecution({
          chainId: safe.chainId,
          safeAddress,
          safeTxHash: tx.safeTxHash as Hex,
        });
      } catch (e) {
        errors++;
        problems.push(`execution lookup failed (${tx.id}): ${messageOf(e)}`);
        console.warn("[safe-sync] execution lookup failed", tx.id, messageOf(e));
        continue; // decide next time rather than supersede on a blind spot
      }
      if (seen?.success) {
        try {
          const res = await recordExecuted({
            fundId: a.fundId,
            transactionId: tx.id,
            txHash: seen.txHash,
            executedBy: tx.txHash && sameAddress(tx.txHash, seen.txHash) ? "relayer" : "external",
            executedAt: new Date(),
          });
          if (res.recorded) {
            executed++;
            if (isOwnerChangeKind(tx.kind)) ownersChanged = true;
          }
        } catch (e) {
          errors++;
          problems.push(`record execution failed (${tx.id}): ${messageOf(e)}`);
          console.error("[safe-sync] record execution failed", tx.id, e);
        }
        continue;
      }
      // Not this transaction. SUPERSEDED either way, but say whether we know
      // what took the slot: a sibling row we recorded as executed, or a
      // transaction La Caisse never saw (older than the execution lookback,
      // or run entirely in Safe{Wallet}) — review S12.
      const sibling = seen
        ? null
        : await prisma.fundSafeTransaction.findFirst({
            where: { safeId: safe.id, safe: { fundId: a.fundId }, nonce: tx.nonce, status: "EXECUTED" },
            select: { id: true },
          });
      await prisma.fundSafeTransaction.updateMany({
        where: { id: tx.id, safe: { fundId: a.fundId }, status: { in: ["PENDING", "EXECUTING", "FAILED"] } },
        data: seen
          ? {
              // The Safe consumed the nonce but the inner call reverted.
              status: "FAILED",
              txHash: seen.txHash,
              errorMessage: "tx_reverted: executed on chain but the call failed",
            }
          : {
              status: "SUPERSEDED",
              errorMessage: sibling
                ? null
                : "nonce consumed by a transaction La Caisse did not record",
            },
      });
      continue;
    }

    if (tx.status === "FAILED") continue;

    if (tx.status === "EXECUTING") {
      // Crash recovery: a relayer attempt that never resolved and whose nonce
      // is still open on chain, i.e. nothing mined.
      if (Date.now() - tx.updatedAt.getTime() > STALE_EXECUTING_MS) {
        await prisma.fundSafeTransaction.updateMany({
          where: { id: tx.id, safe: { fundId: a.fundId }, status: "EXECUTING" },
          data: { status: "FAILED", errorMessage: "execution timed out" },
        });
      }
      continue;
    }

    if (serviceOn) {
      const remote = remoteByHash.get(lc(tx.safeTxHash));
      const safeTx = safeTxFromRow(tx);
      const local = tx.signatures.filter((s) => s.source === "LACAISSE");
      if (!remote) {
        // (2c) Never reached the service (proposed before the Safe was
        // indexed, or an outage): mirror it now with the signatures we hold,
        // so external owners can see and sign it.
        const [first, ...rest] = local;
        if (first) {
          try {
            await proposeTransaction({
              chainId: safe.chainId,
              safeAddress,
              tx: safeTx,
              safeTxHash: tx.safeTxHash as Hex,
              sender: getAddress(first.ownerAddress),
              signature: first.signature as Hex,
            });
            for (const s of rest) {
              await confirmTransaction({
                chainId: safe.chainId,
                safeTxHash: tx.safeTxHash as Hex,
                signature: s.signature as Hex,
              });
            }
          } catch (e) {
            console.warn("[safe-sync] tx-service re-propose failed", tx.id, messageOf(e));
          }
        }
      } else {
        // (2a) import Safe{Wallet} confirmations we don't have yet.
        const have = new Set(tx.signatures.map((s) => lc(s.ownerAddress)));
        for (const c of (remote.confirmations ?? []).slice(0, MAX_CONFIRMATIONS_PER_TX)) {
          // Contract signatures / approved hashes carry no recoverable ECDSA sig.
          if (!c.signature) continue;
          const signature = c.signature;
          let owner: Address;
          try {
            owner = getAddress(c.owner);
          } catch {
            continue;
          }
          if (have.has(lc(owner)) || !ownerSet.has(lc(owner))) continue;
          let recovered: Address;
          try {
            recovered = await recoverSafeTxSigner({
              chainId: safe.chainId,
              safeAddress,
              tx: safeTx,
              signature,
            });
          } catch (e) {
            console.warn("[safe-sync] unrecoverable confirmation skipped", tx.id, owner, messageOf(e));
            continue;
          }
          if (lc(recovered) !== lc(owner)) {
            console.warn("[safe-sync] confirmation signer mismatch skipped", tx.id, owner);
            continue;
          }
          try {
            await prisma.fundSafeSignature.create({
              data: {
                transactionId: tx.id,
                ownerAddress: owner,
                signature,
                source: "SAFE_WALLET",
              },
            });
            have.add(lc(owner));
          } catch (e) {
            if ((e as { code?: string }).code !== "P2002") {
              errors++;
              problems.push(`confirmation import failed (${tx.id}): ${messageOf(e)}`);
              console.error("[safe-sync] confirmation import failed", tx.id, e);
            }
          }
        }
      }
    }

    stillPending.push({ id: tx.id, kind: tx.kind });
  }

  // (4) execute what now meets its threshold, lowest nonce first.
  for (const tx of stillPending) {
    try {
      const res = await tryExecute({ fundId: a.fundId, transactionId: tx.id, fromSync: true });
      if (res.executed) {
        executed++;
        if (isOwnerChangeKind(tx.kind)) ownersChanged = true;
      }
    } catch (e) {
      errors++;
      problems.push(`execution failed (${tx.id}): ${messageOf(e)}`);
      console.warn("[safe-sync] execution failed", tx.id, messageOf(e));
    }
  }

  if (ownersChanged) {
    try {
      const after = await readSafeState({ chainId: safe.chainId, safeAddress });
      await refreshOwners({ fundId: a.fundId, safeId: safe.id, owners: after.owners, threshold: after.threshold });
    } catch (e) {
      console.warn("[safe-sync] post-execution owner refresh failed", safe.id, messageOf(e));
    }
  }

  // (5) A pass that hit errors leaves a note on the Safe (the chain-read
  // failure above does the same); a clean pass clears it.
  await prisma.fundSafe.updateMany({
    where: { id: safe.id, fundId: a.fundId },
    data: { lastSyncedAt: new Date(), errorMessage: syncErrorMessage(problems) },
  });
  return { synced: true, executed, errors };
}

function syncErrorMessage(problems: string[]): string | null {
  const [first, ...rest] = problems;
  if (!first) return null;
  const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
  return `sync: ${first}`.slice(0, 400) + more;
}

// Upsert the owner cache from getOwners(): new chain owners become MEMBER
// rows when a FundSigner of this fund holds the address (else EXTERNAL, label
// taken from the executed ADD/SWAP proposal when there is one); owners gone
// from chain get removedAt, returning ones have it cleared.
async function refreshOwners(a: {
  fundId: string;
  safeId: string;
  owners: Address[];
  threshold: number;
}): Promise<void> {
  const chainOwners = a.owners.map((o) => getAddress(o));
  const chainSet = new Set(chainOwners.map(lc));

  await prisma.fundSafe.updateMany({
    where: { id: a.safeId, fundId: a.fundId },
    data: { threshold: a.threshold },
  });

  const rows = await prisma.fundSafeOwner.findMany({
    where: { safeId: a.safeId, safe: { fundId: a.fundId } },
    select: { id: true, address: true, removedAt: true },
  });
  const byAddress = new Map(rows.map((r) => [lc(r.address), r]));

  let labels: Map<string, string> | null = null;
  const labelFor = async (address: Address): Promise<string | null> => {
    if (!labels) {
      labels = new Map();
      const recent = await prisma.fundSafeTransaction.findMany({
        where: {
          safeId: a.safeId,
          safe: { fundId: a.fundId },
          status: "EXECUTED",
          kind: { in: ["ADD_OWNER", "SWAP_OWNER"] },
        },
        orderBy: { executedAt: "asc" },
        select: { summary: true },
        take: 100,
      });
      for (const r of recent) {
        const s = r.summary as SafeTxSummary | null;
        if (s?.kind === "ADD_OWNER" && s.ownerLabel) labels.set(lc(s.owner), s.ownerLabel);
        if (s?.kind === "SWAP_OWNER" && s.newOwnerLabel) labels.set(lc(s.newOwner), s.newOwnerLabel);
      }
    }
    return labels.get(lc(address)) ?? null;
  };

  for (const owner of chainOwners) {
    const row = byAddress.get(lc(owner));
    if (row) {
      if (row.removedAt) {
        await prisma.fundSafeOwner.update({ where: { id: row.id }, data: { removedAt: null } });
      }
      continue;
    }
    const signer = await prisma.fundSigner.findUnique({
      where: { fundId_address: { fundId: a.fundId, address: owner } },
      select: { id: true },
    });
    await prisma.fundSafeOwner.upsert({
      where: { safeId_address: { safeId: a.safeId, address: owner } },
      create: signer
        ? { safeId: a.safeId, address: owner, kind: "MEMBER", signerId: signer.id }
        : { safeId: a.safeId, address: owner, kind: "EXTERNAL", label: await labelFor(owner) },
      update: { removedAt: null },
    });
  }

  const gone = rows.filter((r) => !r.removedAt && !chainSet.has(lc(r.address))).map((r) => r.id);
  if (gone.length > 0) {
    await prisma.fundSafeOwner.updateMany({
      where: { id: { in: gone }, safeId: a.safeId },
      data: { removedAt: new Date() },
    });
  }
}

// Cron: every ACTIVE safe with open transactions, or not synced for an hour.
// Each safe is synced under its own fundId.
export async function syncAllPendingSafes(): Promise<{
  safes: number;
  executed: number;
  errors: number;
}> {
  const safes = await prisma.fundSafe.findMany({
    where: {
      status: "ACTIVE",
      archivedAt: null,
      OR: [
        { transactions: { some: { status: { in: ["PENDING", "EXECUTING"] } } } },
        { lastSyncedAt: null },
        { lastSyncedAt: { lt: new Date(Date.now() - IDLE_RESYNC_MS) } },
      ],
    },
    select: { id: true, fundId: true },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: 100,
  });

  let synced = 0;
  let executed = 0;
  let errors = 0;
  for (const s of safes) {
    try {
      const res = await syncSafe({ fundId: s.fundId, safeId: s.id });
      if (res.synced) synced++;
      executed += res.executed;
      errors += res.errors;
    } catch (e) {
      errors++;
      console.error("[safe-sync] safe sync failed", s.id, e);
    }
  }
  return { safes: synced, executed, errors };
}
