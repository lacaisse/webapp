// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure helpers for passkey (WebAuthn, P-256) Safe owners — the Safe passkey
// module v0.2.1 (safe-global/safe-modules, modules/passkey). Isomorphic: no
// env, no fetch, no DB, no server-only; the browser-side ceremony and the
// server share them. Unit-tested in passkey-signature.test.ts. Module map:
// services/safe/config.ts.
//
// How a passkey signs a Safe transaction:
//   1. The member's authenticator signs a WebAuthn assertion whose challenge
//      is the 32-byte `safeTxHash` (base64url, no padding — 43 characters).
//      What it actually signs with P-256 is
//        sha256(authenticatorData ‖ sha256(clientDataJSON)).
//   2. The signer contract (SafeWebAuthnSignerProxy, the Safe owner) gets
//        abi.encode(bytes authenticatorData, string clientDataFields, uint256 r, uint256 s)
//      and rebuilds clientDataJSON as
//        {"type":"webauthn.get","challenge":"<base64url(message)>",<clientDataFields>}
//      — so `clientDataFields` is everything the browser put after the
//      challenge (origin, crossOrigin, …). It requires the user-verification
//      flag (0x04) in authenticatorData[32] and accepts high-s signatures; we
//      still normalise to low-s.
//   3. Safe 1.4.1 sees it as a contract signature: a 65-byte static part with
//      v = 0, r = the owner (signer contract) address, s = the byte offset of
//      the dynamic part, and the dynamic part appended as uint256 length ‖
//      bytes. `checkNSignatures` then calls the owner's legacy
//      `isValidSignature(bytes data, bytes)` with the EIP-712 pre-image, which
//      the singleton hashes with keccak256 — i.e. the safeTxHash again.

import {
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  hexToNumber,
  isAddress,
  sha256,
  size,
  slice,
  stringToBytes,
  toHex,
} from "viem";

import { SafeError, type Address, type Hex } from "@/services/safe/types";

// secp256r1 group order and its half (for low-s normalisation).
export const P256_N = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);
const P256_N_DIV_2 = P256_N >> BigInt(1);

// ---------------------------------------------------------------------------
// Module signature encoding
// ---------------------------------------------------------------------------

export type WebAuthnSignature = {
  authenticatorData: Hex;
  clientDataFields: string;
  r: bigint;
  s: bigint;
};

const WEBAUTHN_SIGNATURE_PARAMS = [
  { name: "authenticatorData", type: "bytes" },
  { name: "clientDataFields", type: "string" },
  { name: "r", type: "uint256" },
  { name: "s", type: "uint256" },
] as const;

/** `abi.encode(bytes, string, uint256, uint256)` as the signer contract expects. */
export function encodeWebAuthnSignature(sig: WebAuthnSignature): Hex {
  return encodeAbiParameters(WEBAUTHN_SIGNATURE_PARAMS, [
    sig.authenticatorData,
    sig.clientDataFields,
    sig.r,
    sig.s,
  ]);
}

export function decodeWebAuthnSignature(bytes: Hex): WebAuthnSignature {
  const [authenticatorData, clientDataFields, r, s] = decodeAbiParameters(
    WEBAUTHN_SIGNATURE_PARAMS,
    bytes,
  );
  return { authenticatorData, clientDataFields, r, s };
}

// ---------------------------------------------------------------------------
// WebAuthn pieces
// ---------------------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const base64 =
    typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array {
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin =
    typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The WebAuthn challenge for a 32-byte hash: base64url, no padding (43 chars). */
export function challengeForHash(hash: Hex): string {
  if (size(hash) !== 32) throw new SafeError("invalid_signature", "Challenge is not 32 bytes");
  return base64UrlEncode(hexToBytes(hash));
}

const CLIENT_DATA_GET =
  /^\{"type":"webauthn\.get","challenge":"([A-Za-z0-9_-]{43})",([\s\S]*)\}$/;

/**
 * The part of clientDataJSON the signer contract takes as `clientDataFields`:
 * everything after `"challenge":"…",` up to the closing brace. The JSON must
 * start with exactly `{"type":"webauthn.get","challenge":"…",` (the contract
 * rebuilds it that way, so a browser that serialised the fields in another
 * order could not produce a valid signature) and carry `expectedChallenge`.
 */
export function clientDataFieldsFor(clientDataJSON: string, expectedChallenge: string): string {
  const m = CLIENT_DATA_GET.exec(clientDataJSON);
  if (!m) throw new SafeError("invalid_signature", "Unexpected clientDataJSON layout");
  const [, challenge, fields] = m;
  if (challenge !== expectedChallenge) {
    throw new SafeError("invalid_signature", "Assertion challenge does not match the transaction");
  }
  return fields ?? "";
}

/** Rebuild clientDataJSON the way the contract does (for local checks / tests). */
export function clientDataJsonFor(challenge: string, clientDataFields: string): string {
  return `{"type":"webauthn.get","challenge":"${challenge}",${clientDataFields}}`;
}

/** The bytes the authenticator's P-256 key signs: authData ‖ sha256(clientDataJSON). */
export function webauthnSigningMessage(authenticatorData: Hex, clientDataJSON: string): Hex {
  return concat([authenticatorData, sha256(stringToBytes(clientDataJSON))]);
}

export type AuthenticatorFlags = {
  userPresent: boolean; // 0x01
  userVerified: boolean; // 0x04
  backupEligible: boolean; // 0x08
  backupState: boolean; // 0x10
};

/** The flags byte at authenticatorData[32] (after the 32-byte rpIdHash). */
export function authenticatorFlags(authenticatorData: Hex): AuthenticatorFlags {
  if (size(authenticatorData) < 37) {
    throw new SafeError("invalid_signature", "authenticatorData is too short");
  }
  const flags = hexToNumber(slice(authenticatorData, 32, 33));
  return {
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    backupEligible: (flags & 0x08) !== 0,
    backupState: (flags & 0x10) !== 0,
  };
}

export function rpIdHashOf(authenticatorData: Hex): Hex {
  return slice(authenticatorData, 0, 32);
}

/**
 * (r, s) from the authenticator's ASN.1 DER ECDSA signature:
 *   0x30 len 0x02 rlen r 0x02 slen s
 * `s` is normalised to the low half of the group (the contract accepts both;
 * one canonical form keeps stored signatures comparable).
 */
export function derSignatureToRs(der: Uint8Array): { r: bigint; s: bigint } {
  const fail = () => new SafeError("invalid_signature", "Invalid DER signature");
  if (der.length < 8 || der[0] !== 0x30) throw fail();
  let p = 1;
  let seqLen = der[p++]!;
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    if (n !== 1) throw fail();
    seqLen = der[p++]!;
  }
  if (seqLen !== der.length - p) throw fail();
  const readInt = (): bigint => {
    if (der[p++] !== 0x02) throw fail();
    const len = der[p++]!;
    if (len === 0 || len > 33 || p + len > der.length) throw fail();
    let v = BigInt(0);
    for (let i = 0; i < len; i++) v = (v << BigInt(8)) | BigInt(der[p + i]!);
    p += len;
    return v;
  };
  const r = readInt();
  const s = readInt();
  if (p !== der.length) throw fail();
  if (r <= BigInt(0) || r >= P256_N || s <= BigInt(0) || s >= P256_N) throw fail();
  return { r, s: s > P256_N_DIV_2 ? P256_N - s : s };
}

/** The signer contract's `(r, s)` back to DER (tests / local verification). */
export function rsToDerSignature(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint): number[] => {
    const bytes = Array.from(hexToBytes(toHex(v, { size: 32 })));
    while (bytes.length > 1 && bytes[0] === 0 && (bytes[1]! & 0x80) === 0) bytes.shift();
    if (bytes[0]! & 0x80) bytes.unshift(0);
    return [0x02, bytes.length, ...bytes];
  };
  const body = [...int(r), ...int(s)];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** The (x, y) coordinates of a P-256 point as the factory takes them. */
export function publicKeyCoordinates(x: Uint8Array, y: Uint8Array): { x: Hex; y: Hex } {
  if (x.length !== 32 || y.length !== 32) {
    throw new SafeError("invalid_signature", "P-256 coordinates must be 32 bytes");
  }
  return { x: toHex(x), y: toHex(y) };
}

// ---------------------------------------------------------------------------
// Safe contract signatures (EIP-1271 owners)
// ---------------------------------------------------------------------------

export const CONTRACT_SIGNATURE_STATIC_LENGTH = 65;

/**
 * A standalone Safe contract signature for `owner`: the 65-byte static part
 * (r = owner, s = 65 = where the dynamic part starts, v = 0) followed by the
 * length-prefixed dynamic part. This is the form stored on
 * FundSafeSignature.signature and posted to the Transaction Service as one
 * confirmation; `packSignatures` (safe-tx.ts) re-offsets `s` when several
 * signatures are concatenated.
 */
export function contractSignature(owner: Address, dynamicPart: Hex): Hex {
  return concat([
    toHex(BigInt(getAddress(owner)), { size: 32 }),
    toHex(BigInt(CONTRACT_SIGNATURE_STATIC_LENGTH), { size: 32 }),
    "0x00",
    toHex(BigInt(size(dynamicPart)), { size: 32 }),
    dynamicPart,
  ]);
}

export type ParsedContractSignature = { owner: Address; dynamicPart: Hex };

/**
 * Split a standalone contract signature into its owner and dynamic part;
 * null when `signature` is not one (a plain 65-byte ECDSA signature, or a
 * malformed blob). Strict: v must be 0, r a plain address, s exactly 65 and
 * the dynamic part exactly as long as its prefix says.
 */
export function parseContractSignature(signature: Hex): ParsedContractSignature | null {
  if (!/^0x[0-9a-fA-F]*$/.test(signature)) return null;
  const len = size(signature);
  if (len < CONTRACT_SIGNATURE_STATIC_LENGTH + 32) return null;
  if (hexToNumber(slice(signature, 64, 65)) !== 0) return null;
  const r = slice(signature, 0, 32);
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(r)) return null;
  const ownerHex = `0x${r.slice(26)}`;
  if (!isAddress(ownerHex, { strict: false })) return null;
  const s = BigInt(slice(signature, 32, 64));
  if (s !== BigInt(CONTRACT_SIGNATURE_STATIC_LENGTH)) return null;
  const dynLen = BigInt(slice(signature, 65, 97));
  if (dynLen > BigInt(1_000_000)) return null;
  const end = 97 + Number(dynLen);
  if (end !== len) return null;
  return { owner: getAddress(ownerHex), dynamicPart: slice(signature, 97, end) };
}

export function isContractSignature(signature: Hex): boolean {
  return parseContractSignature(signature) !== null;
}

/** The passkey module signature wrapped as a standalone Safe contract signature. */
export function passkeyContractSignature(owner: Address, sig: WebAuthnSignature): Hex {
  return contractSignature(owner, encodeWebAuthnSignature(sig));
}
