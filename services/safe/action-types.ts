// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SafeTransfersPage } from "./transfers";

// Result types of the Safe server actions (services/safe/admin-actions.ts).
// Kept out of the "use server" file, which may only export async functions.

export type SafeActionResult = { error: string } | { ok: true };
export type CreateSafeActionResult = { error: string } | { ok: true; safeId: string };
export type ProposeActionResult =
  | { error: string }
  | { ok: true; transactionId: string; executed: boolean; txHash: string | null };
export type SignActionResult =
  | { error: string }
  | { ok: true; executed: boolean; txHash: string | null };
export type SafeTransfersActionResult =
  | { error: string }
  | ({ ok: true } & SafeTransfersPage);
