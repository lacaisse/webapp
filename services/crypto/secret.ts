// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

// AES-256-GCM envelope for app secrets stored on Prisma rows (CitizenPay
// API secrets, token-minter private keys, etc.). Generic — not tied to any
// one feature.
//
// Wire format (base64-encoded after the `v1:` prefix):
//   12 bytes iv  || 16 bytes auth tag || ciphertext
//
// Versioning: prefixed with "v1:" so we can rotate the algorithm later
// without ambiguity. Decrypt throws if the prefix or layout is wrong —
// callers should treat a decrypt failure as fatal misconfiguration, not
// a recoverable error.
//
// Key source: `APP_CRED_KEY` env, 32 raw bytes encoded as 64 hex chars.
// Generate with:  openssl rand -hex 32

const VERSION = "v1";
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

export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new Error("[crypto] encryptSecret: empty plaintext");
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decryptSecret(envelope: string): string {
  const sep = envelope.indexOf(":");
  if (sep === -1) {
    throw new Error("[crypto] decryptSecret: missing version prefix");
  }
  const version = envelope.slice(0, sep);
  if (version !== VERSION) {
    throw new Error(`[crypto] decryptSecret: unsupported version ${version}`);
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
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
