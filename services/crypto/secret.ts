// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

// AES-256-GCM envelope for app secrets stored on Prisma rows (CitizenPay
// API secrets, token-minter private keys, Safe signer keys, etc.). Generic —
// not tied to any one feature.
//
// Wire format (base64-encoded after the version prefix):
//   v1:  12 bytes iv || 16 bytes auth tag || ciphertext
//   v2:  same bytes, but the GCM tag also authenticates caller-supplied
//        additional data (AAD) that is NOT stored in the envelope.
//
// Versioning: the prefix lets us rotate the algorithm later without
// ambiguity. Decrypt throws if the prefix or layout is wrong — callers should
// treat a decrypt failure as fatal misconfiguration, not a recoverable error.
//
// AAD (v2) binds a ciphertext to the row it belongs to — e.g. a Safe signer
// key to "signer:<fundId>:<userId>" — so a ciphertext copied onto another row
// (or a row re-pointed at another user) no longer decrypts. Pass the same
// `aad` to decrypt. A v1 envelope has no binding and decrypts regardless of
// `aad` (legacy rows written before the binding existed).
//
// Key source: `APP_CRED_KEY` env, 32 raw bytes encoded as 64 hex chars.
// Generate with:  openssl rand -hex 32

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer {
  const hex = process.env.APP_CRED_KEY;
  if (!hex) {
    throw new Error(
      "[crypto] APP_CRED_KEY is not set — generate with `openssl rand -hex 32`",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "[crypto] APP_CRED_KEY must be 64 hex characters (32 bytes)",
    );
  }
  return Buffer.from(hex, "hex");
}

/** Encrypt; with `aad` the envelope is `v2:` and bound to that string. */
export function encryptSecret(plaintext: string, aad?: string): string {
  if (!plaintext) throw new Error("[crypto] encryptSecret: empty plaintext");
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const version = aad ? "v2" : "v1";
  return `${version}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

/** Envelope version, or null when the prefix is unknown. */
export function envelopeVersion(envelope: string): "v1" | "v2" | null {
  const sep = envelope.indexOf(":");
  if (sep === -1) return null;
  const v = envelope.slice(0, sep);
  return v === "v1" || v === "v2" ? v : null;
}

/**
 * Decrypt. A `v2` envelope needs the `aad` it was sealed with (wrong or
 * missing → "unable to authenticate data"); `v1` ignores it.
 */
export function decryptSecret(envelope: string, aad?: string): string {
  const sep = envelope.indexOf(":");
  if (sep === -1) {
    throw new Error("[crypto] decryptSecret: missing version prefix");
  }
  const version = envelope.slice(0, sep);
  if (version !== "v1" && version !== "v2") {
    throw new Error(`[crypto] decryptSecret: unsupported version ${version}`);
  }
  if (version === "v2" && !aad) {
    throw new Error("[crypto] decryptSecret: v2 envelope needs its binding (aad)");
  }
  const blob = Buffer.from(envelope.slice(sep + 1), "base64");
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("[crypto] decryptSecret: malformed envelope");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const key = loadKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (version === "v2") decipher.setAAD(Buffer.from(aad!, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
