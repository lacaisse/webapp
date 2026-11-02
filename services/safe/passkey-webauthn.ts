// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { createHash } from "node:crypto";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey, isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { hexToBytes, toHex } from "viem";

import {
  authenticatorFlags,
  base64UrlDecode,
  challengeForHash,
  clientDataFieldsFor,
  derSignatureToRs,
  publicKeyCoordinates,
  type WebAuthnSignature,
} from "@/services/safe/passkey-signature";
import { SafeError, type Hex } from "@/services/safe/types";

// The WebAuthn ceremonies behind a member's Safe signing passkey, verified
// with @simplewebauthn/server (the same library the login passkey plugin
// uses). This is NOT the login passkey: a signing credential is registered
// per fund with its own user handle, so an authenticator never overwrites
// the login credential, and pickers show it as "Signing key · <fund> ·
// <email>". Module map: services/safe/config.ts.
//
// Registration: the attestation is parsed (format "none" is fine — we never
// trust an attestation chain, only the public key), the P-256 (x, y) is
// pulled out of the COSE key and the backup flags recorded. Signing: the
// assertion is checked for origin, rpID, user verification and the P-256
// signature over the safeTxHash challenge, then turned into the Safe
// passkey module's signature bytes (passkey-signature.ts). The signer
// contract re-verifies the same bytes on chain (relayer.ts
// verifyContractSignature) — the local check only makes a bad assertion
// fail fast and lets the assertion stand in as the step-up proof.

export const SIGNING_PASSKEY_RP_NAME = "La Caisse";
const ES256 = -7;

/**
 * The WebAuthn user handle of a member's signing credential for a fund.
 * Distinct from the login passkey's handle (the Better Auth user id), so a
 * platform authenticator keeps both; stable per (fund, user), so a
 * replacement registered on the same authenticator overwrites the lost one
 * rather than piling up.
 */
export function signingPasskeyUserHandle(fundId: string, userId: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    createHash("sha256").update(`la-caisse:safe-signer:${fundId}:${userId}`).digest(),
  );
}

/** What the picker shows for the credential. */
export function signingPasskeyUserName(fundName: string, email: string): string {
  return `Signing key · ${fundName} · ${email}`;
}

export function signingPasskeyRegistrationOptions(a: {
  rpID: string;
  fundId: string;
  fundName: string;
  userId: string;
  email: string;
  challenge: Uint8Array;
  excludeCredentialIds: string[];
}): PublicKeyCredentialCreationOptionsJSON {
  const name = signingPasskeyUserName(a.fundName, a.email);
  return {
    rp: { id: a.rpID, name: SIGNING_PASSKEY_RP_NAME },
    user: {
      id: isoBase64URL.fromBuffer(signingPasskeyUserHandle(a.fundId, a.userId)),
      name,
      displayName: name,
    },
    challenge: isoBase64URL.fromBuffer(Uint8Array.from(a.challenge)),
    // ES256 only: the signer contract verifies P-256 and nothing else.
    pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
    timeout: 120_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    excludeCredentials: a.excludeCredentialIds.map((id) => ({ id, type: "public-key" })),
  };
}

export type VerifiedSigningRegistration = {
  credentialId: string; // base64url
  x: Hex;
  y: Hex;
  backupEligible: boolean;
  backupState: boolean;
  transports: string | null;
  aaguid: string | null;
};

export async function verifySigningRegistration(a: {
  response: RegistrationResponseJSON;
  expectedChallenge: string; // base64url
  expectedOrigin: string | string[];
  rpID: string;
}): Promise<VerifiedSigningRegistration> {
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: a.response,
      expectedChallenge: a.expectedChallenge,
      expectedOrigin: a.expectedOrigin,
      expectedRPID: a.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [ES256],
    });
  } catch (e) {
    throw new SafeError("invalid_signature", `Passkey registration rejected: ${messageOf(e)}`, {
      cause: e,
    });
  }
  if (!verified.verified) {
    throw new SafeError("invalid_signature", "Passkey registration could not be verified");
  }
  const info = verified.registrationInfo;
  const key = decodeCredentialPublicKey(info.credential.publicKey);
  if (
    !cose.isCOSEPublicKeyEC2(key) ||
    key.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256 ||
    key.get(cose.COSEKEYS.alg) !== ES256
  ) {
    throw new SafeError("invalid_signature", "Passkey is not a P-256 (ES256) key");
  }
  const x = key.get(cose.COSEKEYS.x);
  const y = key.get(cose.COSEKEYS.y);
  if (!x || !y) throw new SafeError("invalid_signature", "Passkey public key is incomplete");
  const flags = authenticatorFlags(toHex(parseAuthData(a.response)));
  return {
    credentialId: info.credential.id,
    ...publicKeyCoordinates(x, y),
    backupEligible: flags.backupEligible,
    backupState: flags.backupState,
    transports: info.credential.transports?.length ? info.credential.transports.join(",") : null,
    aaguid: info.aaguid && info.aaguid !== "00000000-0000-0000-0000-000000000000" ? info.aaguid : null,
  };
}

// The attestation object's authenticatorData, for the backup flags (the
// library's result exposes them only as a device type + backed-up pair).
function parseAuthData(response: RegistrationResponseJSON): Uint8Array {
  const attestation = isoCBOR.decodeFirst<{ authData: Uint8Array }>(
    isoBase64URL.toBuffer(response.response.attestationObject),
  );
  return attestation.authData;
}

/** COSE EC2 key bytes for stored (x, y), as the verifier wants them. */
export function cosePublicKeyFor(x: Hex, y: Hex): Uint8Array<ArrayBuffer> {
  return isoCBOR.encode(
    new Map<number, number | Uint8Array<ArrayBuffer>>([
      [cose.COSEKEYS.kty, cose.COSEKTY.EC2],
      [cose.COSEKEYS.alg, ES256],
      [cose.COSEKEYS.crv, cose.COSECRV.P256],
      [cose.COSEKEYS.x, Uint8Array.from(hexToBytes(x))],
      [cose.COSEKEYS.y, Uint8Array.from(hexToBytes(y))],
    ]),
  );
}

export type VerifiedSigningAssertion = {
  signature: WebAuthnSignature; // the module's signature parts
  backupEligible: boolean;
  backupState: boolean;
  counter: number;
};

/**
 * Check a signing assertion against the member's credential and the
 * transaction it is for: the challenge must be the safeTxHash, the origin
 * and rpID ours, user verification done, the P-256 signature valid for the
 * stored key. Returns the pieces the signer contract takes.
 */
export async function verifySigningAssertion(a: {
  response: AuthenticationResponseJSON;
  safeTxHash: Hex;
  expectedOrigin: string | string[];
  rpID: string;
  credential: { id: string; x: Hex; y: Hex; counter: number; transports: string | null };
}): Promise<VerifiedSigningAssertion> {
  const challenge = challengeForHash(a.safeTxHash);
  if (a.response.id !== a.credential.id && a.response.rawId !== a.credential.id) {
    throw new SafeError("invalid_signature", "Assertion is from another credential");
  }
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response: a.response,
      expectedChallenge: challenge,
      expectedOrigin: a.expectedOrigin,
      expectedRPID: a.rpID,
      requireUserVerification: true,
      credential: {
        id: a.credential.id,
        publicKey: cosePublicKeyFor(a.credential.x, a.credential.y),
        counter: a.credential.counter,
        transports: a.credential.transports
          ? (a.credential.transports.split(",") as NonNullable<
              Parameters<typeof verifyAuthenticationResponse>[0]["credential"]["transports"]
            >)
          : undefined,
      },
    });
  } catch (e) {
    throw new SafeError("invalid_signature", `Passkey assertion rejected: ${messageOf(e)}`, {
      cause: e,
    });
  }
  if (!verified.verified) {
    throw new SafeError("invalid_signature", "Passkey assertion could not be verified");
  }

  const authenticatorData = toHex(base64UrlDecode(a.response.response.authenticatorData));
  const clientDataJSON = new TextDecoder().decode(
    base64UrlDecode(a.response.response.clientDataJSON),
  );
  const clientDataFields = clientDataFieldsFor(clientDataJSON, challenge);
  const { r, s } = derSignatureToRs(base64UrlDecode(a.response.response.signature));
  const flags = authenticatorFlags(authenticatorData);
  return {
    signature: { authenticatorData, clientDataFields, r, s },
    backupEligible: flags.backupEligible,
    backupState: flags.backupState,
    counter: verified.authenticationInfo.newCounter,
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
