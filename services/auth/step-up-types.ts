// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared vocabulary of step-up authentication (services/auth/step-up.ts),
// kept out of the "use server" files, which may only export async functions.
//
// A sensitive server action that finds no fresh re-authentication answers
// `{ error, code: "reauth_required" }`; the client glue (useStepUp in
// components/reauth-dialog.tsx) recognises the code, opens the re-auth
// dialog and runs the same submit again once the user confirmed.

export const REAUTH_REQUIRED = "reauth_required";

export type ReauthRequiredError = { error: string; code: typeof REAUTH_REQUIRED };

// A type guard, so a caller that returns on it keeps working with the action's
// remaining result shapes.
export function isReauthRequired(res: object): res is ReauthRequiredError {
  return "code" in res && (res as { code?: unknown }).code === REAUTH_REQUIRED;
}
