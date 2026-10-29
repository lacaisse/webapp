// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress } from "viem";

import { prisma } from "@/services/db/prisma";

import { isOwnerChangeKind, recordExecuted, tryExecute } from "./proposals";
import { readSafeState } from "./relayer";
import { buildSafeTx, recoverSafeTxSigner } from "./safe-tx";
import { getMultisigTransaction, isTxServiceEnabled } from "./tx-service";
import { isSafeError, type Address, type Hex, type SafeTxSummary } from "./types";

// Mirror a fund Safe's chain + Safe Transaction Service state into the DB:
// owners / threshold, confirmations made in Safe{Wallet}, transactions
// executed outside La Caisse, nonces consumed by another transaction. Then
// execute whatever now meets its threshold. Scoped like proposals.ts: the
// safe is loaded by (id, fundId) and every transaction through it.

const MIN_SYNC_INTERVAL_MS = 30 * 1000;
const STALE_EXECUTING_MS = 10 * 60 * 1000;
const IDLE_RESYNC_MS = 60 * 60 * 1000;

const lc = (a: string) => a.toLowerCase();

function messageOf(e: unknown): string {
  if (isSafeError(e)) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
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
    select: { id: true, fundId: true, chainId: true, address: true, status: true, lastSyncedAt: true },
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
  const owners = await prisma.fundSafeOwner.findMany({
    where: { safeId: safe.id, removedAt: null, safe: { fundId: a.fundId } },
    select: { address: true },
  });
  const ownerSet = new Set(owners.map((o) => lc(o.address)));

  const serviceOn = isTxServiceEnabled(safe.chainId);
  let errors = 0;
  let executed = 0;
  let ownersChanged = false;

  const txs = await prisma.fundSafeTransaction.findMany({
    where: {
      safeId: safe.id,
      safe: { fundId: a.fundId },
      status: { in: ["PENDING", "EXECUTING", "FAILED"] },
    },
    include: { signatures: { select: { ownerAddress: true } } },
    orderBy: [{ nonce: "asc" }, { createdAt: "asc" }],
  });

  const stillPending: { id: string; kind: (typeof txs)[number]["kind"] }[] = [];

  for (const tx of txs) {
    // FAILED rows only matter when the service says they ran after all.
    let remote: Awaited<ReturnType<typeof getMultisigTransaction>> = null;
    if (serviceOn) {
      try {
        remote = await getMultisigTransaction({ chainId: safe.chainId, safeTxHash: tx.safeTxHash as Hex });
      } catch (e) {
        console.warn("[safe-sync] tx-service read failed", tx.id, messageOf(e));
      }
    }

    // (2b) executed outside La Caisse (or our own execution whose bookkeeping
    // was lost) → EXECUTED.
    if (remote?.isExecuted) {
      if (remote.isSuccessful === false) {
        // The Safe consumed the nonce but the inner call reverted.
        await prisma.fundSafeTransaction.updateMany({
          where: { id: tx.id, safe: { fundId: a.fundId }, status: { in: ["PENDING", "EXECUTING", "FAILED"] } },
          data: {
            status: "FAILED",
            txHash: remote.transactionHash ?? tx.txHash,
            errorMessage: "tx_reverted: executed on chain but the call failed",
          },
        });
        continue;
      }
      const remoteHash = remote.transactionHash;
      const ours = !!tx.txHash && !!remoteHash && lc(tx.txHash) === lc(remoteHash);
      try {
        const res = await recordExecuted({
          fundId: a.fundId,
          transactionId: tx.id,
          txHash: remoteHash,
          executedBy: ours ? "relayer" : "external",
          executedAt: remote.executionDate ? new Date(remote.executionDate) : new Date(),
        });
        if (res.recorded) {
          executed++;
          if (isOwnerChangeKind(tx.kind)) ownersChanged = true;
        }
      } catch (e) {
        errors++;
        console.error("[safe-sync] record external execution failed", tx.id, e);
      }
      continue;
    }

    if (tx.status === "FAILED") continue;

    if (tx.status === "EXECUTING") {
      // Crash recovery: a relayer attempt that never resolved.
      if (Date.now() - tx.updatedAt.getTime() > STALE_EXECUTING_MS) {
        await prisma.fundSafeTransaction.updateMany({
          where: { id: tx.id, safe: { fundId: a.fundId }, status: "EXECUTING" },
          data: { status: "FAILED", errorMessage: "execution timed out" },
        });
      }
      continue;
    }

    // (3) PENDING whose nonce another transaction consumed.
    if (state.nonce > tx.nonce) {
      await prisma.fundSafeTransaction.updateMany({
        where: { id: tx.id, safe: { fundId: a.fundId }, status: "PENDING" },
        data: { status: "SUPERSEDED" },
      });
      continue;
    }

    // (2a) import Safe{Wallet} confirmations we don't have yet.
    if (remote) {
      const have = new Set(tx.signatures.map((s) => lc(s.ownerAddress)));
      const safeTx = buildSafeTx({
        to: tx.to as Address,
        value: BigInt(tx.value),
        data: tx.data as Hex,
        nonce: BigInt(tx.nonce),
        operation: tx.operation === 1 ? 1 : 0,
      });
      for (const c of remote.confirmations ?? []) {
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
            console.error("[safe-sync] confirmation import failed", tx.id, e);
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

  // (5)
  await prisma.fundSafe.updateMany({
    where: { id: safe.id, fundId: a.fundId },
    data: { lastSyncedAt: new Date(), errorMessage: null },
  });
  return { synced: true, executed, errors };
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
