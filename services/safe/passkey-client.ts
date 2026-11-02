// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  WebAuthnError,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import type { SigningPasskeyHandle } from "@/services/safe/action-types";
import { challengeForHash } from "@/services/safe/passkey-signature";
import type { Hex } from "@/services/safe/types";

// Browser side of the two ceremonies (the server side is
// services/safe/passkey-actions.ts). Thin wrappers over
// @simplewebauthn/browser, which handles the base64url ⇄ ArrayBuffer
// plumbing of the WebAuthn API.

/** The authenticator declined, timed out, or the user dismissed the prompt. */
export function isCeremonyCancelled(e: unknown): boolean {
  if (e instanceof WebAuthnError) {
    return e.name === "NotAllowedError" || e.code === "ERROR_CEREMONY_ABORTED";
  }
  return e instanceof Error && e.name === "NotAllowedError";
}

export function ceremonyErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof WebAuthnError) return e.message || fallback;
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Create the dedicated signing credential from the server's options. */
export async function createSigningPasskey(
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON: options });
}

/**
 * Sign a Safe transaction: a WebAuthn assertion whose challenge is the
 * safeTxHash, restricted to the member's signing credential for this fund
 * (no discoverable-credential picker: the login passkey must not answer).
 */
export async function assertSigningPasskey(
  handle: SigningPasskeyHandle,
  safeTxHash: Hex,
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({
    optionsJSON: {
      challenge: challengeForHash(safeTxHash),
      rpId: handle.rpId,
      timeout: 120_000,
      userVerification: "required",
      allowCredentials: [
        {
          id: handle.credentialId,
          type: "public-key",
          transports: handle.transports as AuthenticatorTransport[],
        },
      ],
    },
  });
}
