// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure part of services/safe/migration.ts: which of a Safe's owners should
// be swapped for a member's current passkey signer, and how far each one
// is. Unit-tested in migration-state.test.ts.

import type { OwnerMigrationReason } from "@/services/safe/types";

export type MigrationOwnerInput = {
  address: string;
  kind: "MEMBER" | "EXTERNAL" | "PASSKEY";
  userId: string | null; // the person behind a MEMBER / PASSKEY owner
  passkeyReplaced: boolean; // PASSKEY owner whose credential was replaced
};

export type MigrationTargetInput = {
  address: string; // the member's active passkey signer
  deployed: boolean;
};

export type MigrationSwapInput = {
  transactionId: string;
  oldOwner: string;
  newOwner: string;
  status: "PENDING" | "EXECUTING" | "FAILED";
  signatures: number;
};

export type MigrationStep =
  | "register" // the member has no active passkey yet
  | "deploy" // passkey registered, signer contract not on chain yet
  | "propose" // ready: nobody proposed the swap yet
  | "signing" // a swap is proposed and collecting signatures
  | "executing" // the relayer is running the swap
  | "failed"; // the swap's last execution failed (retryable)

export type MigrationRow = {
  ownerAddress: string;
  reason: OwnerMigrationReason;
  userId: string | null;
  targetAddress: string | null;
  step: MigrationStep;
  swap: MigrationSwapInput | null;
};

const lc = (a: string) => a.toLowerCase();

/**
 * One row per owner that is still a server-held key (MEMBER) or a replaced
 * passkey, with the step the migration is at for it. Owners whose person is
 * unknown (orphaned MEMBER row) still get a row: they must be swapped (or
 * removed) by the others, so the banner names them.
 */
export function migrationRows(
  owners: MigrationOwnerInput[],
  targetsByUser: Map<string, MigrationTargetInput>,
  openSwaps: MigrationSwapInput[],
): MigrationRow[] {
  const rows: MigrationRow[] = [];
  for (const o of owners) {
    let reason: OwnerMigrationReason;
    if (o.kind === "MEMBER") reason = "server_key";
    else if (o.kind === "PASSKEY" && o.passkeyReplaced) reason = "replaced_passkey";
    else continue;

    const target = o.userId ? (targetsByUser.get(o.userId) ?? null) : null;
    // A target that is the owner itself (a replaced passkey whose successor
    // was not registered yet) is no target.
    const targetAddress = target && lc(target.address) !== lc(o.address) ? target.address : null;
    const swap =
      openSwaps.find((s) => lc(s.oldOwner) === lc(o.address)) ?? null;

    let step: MigrationStep;
    if (swap) {
      step = swap.status === "EXECUTING" ? "executing" : swap.status === "FAILED" ? "failed" : "signing";
    } else if (!targetAddress) {
      step = "register";
    } else if (!target!.deployed) {
      step = "deploy";
    } else {
      step = "propose";
    }
    rows.push({
      ownerAddress: o.address,
      reason,
      userId: o.userId,
      targetAddress: swap ? swap.newOwner : targetAddress,
      step,
      swap,
    });
  }
  return rows;
}

/**
 * Whether a legacy signer's ciphertext may be erased: no unarchived Safe of
 * the fund lists its address as a current owner. Pure counterpart of the
 * sweep in migration.ts.
 */
export function serverKeyErasable(listedOnUnarchivedSafes: number): boolean {
  return listedOnUnarchivedSafes === 0;
}
