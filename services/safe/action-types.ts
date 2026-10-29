// SPDX-License-Identifier: AGPL-3.0-or-later

import { REAUTH_REQUIRED } from "@/services/auth/step-up-types";
import type { SafeTransfersPage } from "./transfers";

// Result types of the Safe server actions (services/safe/admin-actions.ts).
// Kept out of the "use server" file, which may only export async functions.

// `reauth_required`: the action wants a fresh re-authentication first
// (services/auth/step-up.ts); the dialogs open the re-auth dialog and retry.
// The vocabulary itself lives in services/auth/step-up-types.ts, shared with
// the other step-up consumers (the /token mint/burn actions).
export { REAUTH_REQUIRED, isReauthRequired } from "@/services/auth/step-up-types";
export type ActionError = { error: string; code?: typeof REAUTH_REQUIRED };

export type SafeActionResult = { error: string } | { ok: true };
export type CreateSafeActionResult = { error: string } | { ok: true; safeId: string };
export type ProposeActionResult =
  | ActionError
  | { ok: true; transactionId: string; executed: boolean; txHash: string | null };
export type SignActionResult =
  | ActionError
  | { ok: true; executed: boolean; txHash: string | null };
export type WithdrawActionResult = { error: string } | { ok: true; mirrored: boolean };
export type SafeTransfersActionResult =
  | { error: string }
  | ({ ok: true } & SafeTransfersPage);
