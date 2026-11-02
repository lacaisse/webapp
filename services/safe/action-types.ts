// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

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
  | {
      ok: true;
      transactionId: string;
      safeTxHash: string;
      executed: boolean;
      txHash: string | null;
      // The proposer owns the Safe with a passkey: the proposal is stored
      // unsigned and the dialog runs the signing ceremony next.
      awaitingSignature: boolean;
    };
export type SignActionResult =
  | ActionError
  | { ok: true; executed: boolean; txHash: string | null };

// Signing passkey registration (services/safe/passkey-actions.ts).
export type PasskeyRegistrationStartResult =
  | ActionError
  | { ok: true; challengeId: string; options: PublicKeyCredentialCreationOptionsJSON };
export type PasskeyRegistrationFinishResult =
  | { error: string }
  | {
      ok: true;
      address: string;
      deployed: boolean;
      backupEligible: boolean;
      backupState: boolean;
      deployError: string | null;
    };
export type PasskeyDeployResult = { error: string } | { ok: true; address: string };

// What the browser needs to run a signing ceremony for the current user.
export type SigningPasskeyHandle = {
  credentialId: string; // base64url
  transports: string[]; // allowCredentials hints
  address: string; // the signer contract (the Safe owner)
  rpId: string;
};
export type WithdrawActionResult = { error: string } | { ok: true; mirrored: boolean };
export type SafeTransfersActionResult =
  | { error: string }
  | ({ ok: true } & SafeTransfersPage);
