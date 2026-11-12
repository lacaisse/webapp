// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure core of scripts/rotate-app-cred-key.ts: the AES-256-GCM envelope
// cipher (a copy — services/crypto/secret.ts is `server-only` and won't load
// under tsx) and the per-row decision "already current / migrate / failed".
// No Prisma here so scripts/lib/app-cred-rotation.test.ts can cross-check the
// copy against the real module without a database.
//
// Mirrors services/crypto/secret.ts. Wire format MUST stay in sync:
//   v1:  12 bytes iv || 16 bytes auth tag || ciphertext          (no aad)
//   v2:  same bytes, GCM tag also authenticates caller-supplied aad
// Here the key is an explicit argument instead of APP_CRED_KEY, because the
// script holds two keys at once (the retiring one and the new one).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export type EnvelopeVersion = "v1" | "v2";

export function parseHexKey(name: string, hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} must be 64 hex characters (32 bytes).`);
  }
  return Buffer.from(hex, "hex");
}

export function envelopeVersion(envelope: string): EnvelopeVersion | null {
  const sep = envelope.indexOf(":");
  if (sep === -1) return null;
  const v = envelope.slice(0, sep);
  return v === "v1" || v === "v2" ? v : null;
}

export function encryptWith(
  key: Buffer,
  plaintext: string,
  version: EnvelopeVersion,
  aad?: string,
): string {
  if (!plaintext) throw new Error("empty plaintext");
  if (version === "v2" && !aad) throw new Error("v2 envelope needs its aad");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (version === "v2") cipher.setAAD(Buffer.from(aad!, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decryptWith(key: Buffer, envelope: string, aad?: string): string {
  const version = envelopeVersion(envelope);
  if (!version) throw new Error("unsupported envelope version");
  if (version === "v2" && !aad) throw new Error("v2 envelope needs its aad");
  const blob = Buffer.from(envelope.slice(envelope.indexOf(":") + 1), "base64");
  if (blob.length < IV_LEN + TAG_LEN + 1) throw new Error("malformed envelope");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (version === "v2") decipher.setAAD(Buffer.from(aad!, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export type RowOutcome =
  // Decrypts with the new key alone: nothing to do (a second run after
  // --apply should report every row like this).
  | { status: "current" }
  // Decrypted with the previous key, re-encrypted under the new one (same
  // version and aad) and read back with the new key.
  | { status: "migrate"; next: string }
  // Neither key opens it (or the envelope is unreadable). `reason` is safe to
  // print: it never carries plaintext or key material.
  | { status: "failed"; reason: string };

/**
 * Decide what to do with one encrypted cell. `aad` is the binding the row's
 * v2 envelope was sealed with (ignored for v1); a v2 envelope on a column
 * that has no binding fails rather than guessing one.
 */
export function rotateEnvelope(
  envelope: string,
  keys: { current: Buffer; previous: Buffer },
  aad?: string,
): RowOutcome {
  const version = envelopeVersion(envelope);
  if (!version) return { status: "failed", reason: "unknown envelope version" };
  if (version === "v2" && !aad) {
    return { status: "failed", reason: "v2 envelope on a column without a binding" };
  }
  const binding = version === "v2" ? aad : undefined;

  try {
    decryptWith(keys.current, envelope, binding);
    return { status: "current" };
  } catch {
    // Not the new key — fall through to the previous one.
  }

  let plaintext: string;
  try {
    plaintext = decryptWith(keys.previous, envelope, binding);
  } catch {
    return { status: "failed", reason: "decrypts with neither key" };
  }

  let next: string;
  try {
    next = encryptWith(keys.current, plaintext, version, binding);
  } catch (e) {
    return { status: "failed", reason: `re-encrypt: ${(e as Error).message}` };
  }
  try {
    if (decryptWith(keys.current, next, binding) !== plaintext) {
      return { status: "failed", reason: "read-back mismatch" };
    }
  } catch {
    return { status: "failed", reason: "read-back with the new key failed" };
  }
  return { status: "migrate", next };
}

export type ColumnCounts = { migrated: number; current: number; failed: number };

export function emptyCounts(): ColumnCounts {
  return { migrated: 0, current: 0, failed: 0 };
}

export function countOutcome(counts: ColumnCounts, outcome: RowOutcome): void {
  if (outcome.status === "current") counts.current += 1;
  else if (outcome.status === "migrate") counts.migrated += 1;
  else counts.failed += 1;
}

export function signerBinding(fundId: string, userId: string): string {
  // Mirrors services/safe/signer.ts::signerBinding.
  return `signer:${fundId}:${userId}`;
}
