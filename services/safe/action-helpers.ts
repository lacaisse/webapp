// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { getTranslations } from "next-intl/server";
import { refresh, revalidatePath } from "next/cache";

import { hasRecentAuth } from "@/services/auth/step-up";

import { REAUTH_REQUIRED, type ActionError, type ProposeActionResult } from "./action-types";
import { actingOwnerKind, type ProposeResult } from "./proposals";
import { isSafeError } from "./types";

// Helpers shared by the Safe server actions (admin-actions.ts) and the
// token-conversion ones (services/convert/admin-actions.ts). Kept out of the
// "use server" files, which may only export async functions — and whose
// exports would otherwise become callable server references.

export type T = Awaited<ReturnType<typeof getTranslations>>;

// SafeError code → `fund.safes.errors.<code>`; anything else is logged and
// reported as `unknown`.
export function errorFor(t: T, e: unknown, context: string): string {
  if (isSafeError(e)) {
    if (
      e.code !== "not_owner" &&
      e.code !== "already_signed" &&
      e.code !== "threshold" &&
      e.code !== "queue_full" &&
      e.code !== "holds_value" &&
      e.code !== "passkey_missing" &&
      e.code !== "passkey_exists" &&
      e.code !== "rules_spare_owner" &&
      e.code !== "rules_one_person"
    ) {
      console.warn(`[safe] ${context}:`, e.code, e.message);
    }
    return t(`fund.safes.errors.${e.code}` as never);
  }
  console.error(`[safe] ${context} failed`, e);
  return t("fund.safes.errors.unknown" as never);
}

// Step-up (review S4): proposing, signing, rejecting and retrying move the
// Safe's money or change who controls it, so a session cookie alone is not
// enough — the acting user must have re-entered their password or asserted
// a passkey within the last 10 minutes. Checked after the role and input
// checks, before anything is written; the dialogs understand the code.
export async function requireStepUp(t: T): Promise<ActionError | null> {
  if (await hasRecentAuth()) return null;
  return { error: t("auth.errors.reauthRequired" as never), code: REAUTH_REQUIRED };
}

// A passkey owner's proposal is stored unsigned (withdrawable, moving
// nothing) and the signing ceremony that follows is itself the step-up, so
// the re-authentication before the proposal is only asked of legacy
// server-key proposers.
export async function requireProposerStepUp(
  t: T,
  a: { fundId: string; safeId: string; userId: string },
): Promise<ActionError | null> {
  if ((await actingOwnerKind(a)) === "PASSKEY") return null;
  return requireStepUp(t);
}

export function proposed(res: ProposeResult): ProposeActionResult {
  return {
    ok: true,
    transactionId: res.transactionId,
    safeTxHash: res.safeTxHash,
    executed: res.executed,
    txHash: res.txHash,
    awaitingSignature: res.awaitingSignature,
  };
}

export function revalidateSafe(safeId?: string) {
  revalidatePath("/accounts");
  if (safeId) revalidatePath(`/accounts/safes/${safeId}`);
  refresh();
}
