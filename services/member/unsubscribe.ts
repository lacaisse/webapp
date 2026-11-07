// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, timingSafeEqual } from "node:crypto";

// Opt-out (deregistration) links embedded in member emails. The link must be
// usable without a session — the recipient clicks it from their inbox — so we
// can't rely on auth. Instead the token is a stateless, tamper-proof MAC over
// the member id:
//
//   token = "<memberId>.<base64url(HMAC-SHA256(APP_CRED_KEY, memberId))>"
//
// No DB row, no migration, no expiry: an unsubscribe link should keep working
// for the life of the membership. The signature stops anyone from
// unsubscribing arbitrary members by guessing ids. Verification recomputes the
// MAC and compares in constant time.
//
// We reuse APP_CRED_KEY (already required at runtime, 32 bytes hex) rather than
// minting a new secret — the worst a leaked unsubscribe MAC enables is opting
// a member out of reminders, which they can undo, so it shares the app secret
// without widening the blast radius.
//
// Key rotation: links already sent carry a MAC under the old key, and they
// must keep working for the life of the membership. While
// `APP_CRED_KEY_PREVIOUS` is set (see services/crypto/secret.ts) verification
// accepts a MAC under either key; new links are always signed with the
// current key. Once the previous key is dropped from the env, links signed
// under it stop verifying — that is the one thing the rotation script cannot
// re-encrypt, so keep the previous key around for as long as old emails
// should stay actionable.

function parseKey(name: string, hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`[unsubscribe] ${name} must be 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, "hex");
}

function loadKey(): Buffer {
  const hex = process.env.APP_CRED_KEY;
  if (!hex) {
    throw new Error(
      "[unsubscribe] APP_CRED_KEY is not set — generate with `openssl rand -hex 32`",
    );
  }
  return parseKey("APP_CRED_KEY", hex);
}

function loadPreviousKey(): Buffer | null {
  const hex = process.env.APP_CRED_KEY_PREVIOUS;
  if (!hex) return null;
  return parseKey("APP_CRED_KEY_PREVIOUS", hex);
}

function signWith(key: Buffer, memberId: string): string {
  return createHmac("sha256", key).update(memberId).digest("base64url");
}

function sign(memberId: string): string {
  return signWith(loadKey(), memberId);
}

function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildUnsubscribeToken(memberId: string): string {
  return `${memberId}.${sign(memberId)}`;
}

// Returns the member id if the token is well-formed and the signature checks
// out under the current key — or, during a rotation, under the previous key —
// otherwise null. Never throws on malformed input — callers treat null as
// "invalid link".
export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const memberId = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  if (!memberId || !provided) return null;

  let key: Buffer;
  let previous: Buffer | null;
  try {
    key = loadKey();
    previous = loadPreviousKey();
  } catch {
    return null;
  }

  if (matches(provided, signWith(key, memberId))) return memberId;
  if (previous && matches(provided, signWith(previous, memberId))) return memberId;
  return null;
}
