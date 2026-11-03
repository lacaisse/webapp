// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import type { ReauthRequiredError } from "@/services/auth/step-up-types";

// STUB — replaced by the events worker.

export type HolderClaimActionResult = { ok: true } | { error: string };
export type DetachCardHolderResult = { ok: true } | { error: string } | ReauthRequiredError;

export async function confirmCardHolderClaimAction(_input: {
  claimId: string;
}): Promise<HolderClaimActionResult> {
  return { error: "not implemented" };
}

export async function refuseCardHolderClaimAction(_input: {
  claimId: string;
}): Promise<HolderClaimActionResult> {
  return { error: "not implemented" };
}

export async function detachCardHolderAction(_input: {
  cardId: string;
}): Promise<DetachCardHolderResult> {
  return { error: "not implemented" };
}
