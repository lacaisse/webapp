// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress } from "viem";

import { prisma } from "@/services/db/prisma";

import { migrationRows, type MigrationRow, type MigrationSwapInput } from "./migration-state";
import { lc } from "./safe-tx";
import type { SafeTxSummary } from "./types";

// Server-key → passkey migration (and lost-device replacement) of a Safe's
// team owners. Nothing here touches the chain on its own: the banner in the
// Safe page lists what is left to do, each step is an ordinary proposal
// (proposals.ts proposeOwnerChange SWAP_OWNER, signed by the other owners),
// and the sweep below only erases legacy ciphertexts that no unarchived
// Safe can use any more. Module map: services/safe/config.ts.

export type SafeMigrationRow = MigrationRow & {
  displayName: string;
  email: string | null;
  // The user the current viewer is: they can register / replace their own
  // passkey, nobody else's.
  isCurrentUser: boolean;
};

/**
 * The owners of `safeId` still on a server-held key or a replaced passkey,
 * with each one's migration step. Empty when nothing needs moving.
 */
export async function safeMigrationRows(a: {
  fundId: string;
  safeId: string;
  currentUserId: string;
}): Promise<SafeMigrationRow[]> {
  const owners = await prisma.fundSafeOwner.findMany({
    where: { safeId: a.safeId, removedAt: null, safe: { fundId: a.fundId } },
    orderBy: { addedAt: "asc" },
    select: {
      address: true,
      kind: true,
      signer: { select: { userId: true, user: { select: { name: true, email: true } } } },
      passkey: {
        select: { userId: true, replacedAt: true, user: { select: { name: true, email: true } } },
      },
    },
  });
  const inputs = owners.map((o) => ({
    address: o.address,
    kind: o.kind,
    userId: o.signer?.userId ?? o.passkey?.userId ?? null,
    passkeyReplaced: Boolean(o.passkey?.replacedAt),
  }));
  if (!inputs.some((o) => o.kind === "MEMBER" || o.passkeyReplaced)) return [];

  const userIds = [...new Set(inputs.map((o) => o.userId).filter((u): u is string => Boolean(u)))];
  const targets = userIds.length
    ? await prisma.fundPasskeySigner.findMany({
        where: { fundId: a.fundId, userId: { in: userIds }, replacedAt: null },
        orderBy: { createdAt: "asc" },
        select: { userId: true, address: true, deployedAt: true },
      })
    : [];
  const targetsByUser = new Map(
    targets.map((t) => [t.userId, { address: t.address, deployed: Boolean(t.deployedAt) }]),
  );

  const swaps = await prisma.fundSafeTransaction.findMany({
    where: {
      safeId: a.safeId,
      safe: { fundId: a.fundId },
      kind: "SWAP_OWNER",
      status: { in: ["PENDING", "EXECUTING", "FAILED"] },
    },
    select: { id: true, status: true, summary: true, _count: { select: { signatures: true } } },
  });
  const openSwaps: MigrationSwapInput[] = [];
  for (const s of swaps) {
    const summary = s.summary as SafeTxSummary | null;
    if (summary?.kind !== "SWAP_OWNER") continue;
    openSwaps.push({
      transactionId: s.id,
      oldOwner: summary.oldOwner,
      newOwner: summary.newOwner,
      status: s.status as MigrationSwapInput["status"],
      signatures: s._count.signatures,
    });
  }

  const rows = migrationRows(inputs, targetsByUser, openSwaps);
  return rows.map((r) => {
    const o = owners.find((x) => lc(x.address) === lc(r.ownerAddress));
    const user = o?.signer?.user ?? o?.passkey?.user ?? null;
    return {
      ...r,
      displayName: user?.name?.trim() || user?.email || shortAddress(r.ownerAddress),
      email: user?.email ?? null,
      isCurrentUser: r.userId === a.currentUserId,
    };
  });
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Retire legacy server keys of a fund: a signer whose address a migration
 * swap moved off a Safe gets `retiredAt`; a signer no unarchived Safe lists
 * as a current owner any more gets its ciphertext erased (`privateKeyEnc`
 * null, `keyDeletedAt`). Idempotent; run by sync after the owner refresh.
 * Returns what changed, for logging.
 */
export async function retireServerKeys(fundId: string): Promise<{ retired: number; erased: number }> {
  const signers = await prisma.fundSigner.findMany({
    where: { fundId, OR: [{ retiredAt: null }, { privateKeyEnc: { not: null } }] },
    select: { id: true, address: true, retiredAt: true, privateKeyEnc: true },
  });
  if (signers.length === 0) return { retired: 0, erased: 0 };

  let retired = 0;
  let erased = 0;
  const now = new Date();

  // (a) retiredAt: a SWAP_OWNER executed on any Safe of the fund with the
  // signer's address as oldOwner and the migration flag.
  const executedSwaps = await prisma.fundSafeTransaction.findMany({
    where: { safe: { fundId }, kind: "SWAP_OWNER", status: "EXECUTED" },
    select: { summary: true },
  });
  const migratedAway = new Set<string>();
  for (const s of executedSwaps) {
    const summary = s.summary as SafeTxSummary | null;
    if (summary?.kind === "SWAP_OWNER" && summary.migration === "server_key") {
      migratedAway.add(lc(summary.oldOwner));
    }
  }

  for (const signer of signers) {
    const address = getAddress(signer.address);
    if (!signer.retiredAt && migratedAway.has(lc(address))) {
      const res = await prisma.fundSigner.updateMany({
        where: { id: signer.id, fundId, retiredAt: null },
        data: { retiredAt: now },
      });
      retired += res.count;
    }
    if (signer.privateKeyEnc) {
      // (b) erase: no unarchived Safe of the fund lists it as a current owner.
      const listed = await prisma.fundSafeOwner.count({
        where: {
          signerId: signer.id,
          removedAt: null,
          safe: { fundId, archivedAt: null },
        },
      });
      if (listed === 0) {
        const res = await prisma.fundSigner.updateMany({
          where: { id: signer.id, fundId, privateKeyEnc: { not: null } },
          data: { privateKeyEnc: null, keyDeletedAt: now },
        });
        erased += res.count;
      }
    }
  }
  if (retired || erased) {
    console.info("[safe] server keys retired", fundId, { retired, erased });
  }
  return { retired, erased };
}
