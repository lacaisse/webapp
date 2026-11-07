// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { decryptSecret, encryptSecret, envelopeVersion } from "./secret";

const KEY = "0123456789abcdef".repeat(4);
const OLD_KEY = "fedcba9876543210".repeat(4);
let saved: string | undefined;
let savedPrevious: string | undefined;

beforeAll(() => {
  saved = process.env.APP_CRED_KEY;
  savedPrevious = process.env.APP_CRED_KEY_PREVIOUS;
  process.env.APP_CRED_KEY = KEY;
  delete process.env.APP_CRED_KEY_PREVIOUS;
});
afterAll(() => {
  if (saved === undefined) delete process.env.APP_CRED_KEY;
  else process.env.APP_CRED_KEY = saved;
  if (savedPrevious === undefined) delete process.env.APP_CRED_KEY_PREVIOUS;
  else process.env.APP_CRED_KEY_PREVIOUS = savedPrevious;
});

/** Run `fn` with the given current / previous keys, then restore the defaults. */
function withKeys<T>(
  current: string,
  previous: string | undefined,
  fn: () => T,
): T {
  process.env.APP_CRED_KEY = current;
  if (previous === undefined) delete process.env.APP_CRED_KEY_PREVIOUS;
  else process.env.APP_CRED_KEY_PREVIOUS = previous;
  try {
    return fn();
  } finally {
    process.env.APP_CRED_KEY = KEY;
    delete process.env.APP_CRED_KEY_PREVIOUS;
  }
}

describe("secret envelope", () => {
  it("round-trips a v1 envelope (no binding)", () => {
    const env = encryptSecret("0xdeadbeef");
    expect(envelopeVersion(env)).toBe("v1");
    expect(decryptSecret(env)).toBe("0xdeadbeef");
    // Legacy rows decrypt whatever binding the caller now passes.
    expect(decryptSecret(env, "signer:f:u")).toBe("0xdeadbeef");
  });

  it("binds a v2 envelope to its aad", () => {
    const env = encryptSecret("0xdeadbeef", "signer:fund-1:user-1");
    expect(envelopeVersion(env)).toBe("v2");
    expect(decryptSecret(env, "signer:fund-1:user-1")).toBe("0xdeadbeef");
    expect(() => decryptSecret(env, "signer:fund-1:user-2")).toThrow();
    expect(() => decryptSecret(env, "signer:fund-2:user-1")).toThrow();
    expect(() => decryptSecret(env)).toThrow(/binding/);
  });

  it("rejects tampering and unknown versions", () => {
    const env = encryptSecret("secret", "x");
    const [, b64] = env.split(":");
    const bytes = Buffer.from(b64!, "base64");
    bytes[bytes.length - 1] ^= 0x01;
    expect(() => decryptSecret(`v2:${bytes.toString("base64")}`, "x")).toThrow();
    expect(() => decryptSecret(`v3:${b64}`, "x")).toThrow(/unsupported/);
    expect(() => decryptSecret("nope")).toThrow(/version/);
    expect(envelopeVersion("v9:abc")).toBeNull();
  });

  describe("key rotation (APP_CRED_KEY_PREVIOUS)", () => {
    // Sealed under OLD_KEY, as every row is before a rotation.
    const sealedV1 = withKeys(OLD_KEY, undefined, () => encryptSecret("minter-key"));
    const sealedV2 = withKeys(OLD_KEY, undefined, () =>
      encryptSecret("signer-key", "signer:fund-1:user-1"),
    );

    it("decrypts with the current key without touching the previous one", () => {
      const env = encryptSecret("current", "signer:f:u");
      // A previous key that could not open anything must not get in the way.
      expect(withKeys(KEY, OLD_KEY, () => decryptSecret(env, "signer:f:u"))).toBe("current");
      expect(withKeys(KEY, OLD_KEY, () => decryptSecret(encryptSecret("plain")))).toBe("plain");
    });

    it("falls back to the previous key for rows sealed before the rotation", () => {
      expect(withKeys(KEY, OLD_KEY, () => decryptSecret(sealedV1))).toBe("minter-key");
      expect(
        withKeys(KEY, OLD_KEY, () => decryptSecret(sealedV2, "signer:fund-1:user-1")),
      ).toBe("signer-key");
    });

    it("refuses when neither key matches", () => {
      // No previous key configured: an old row is unreadable.
      expect(() => withKeys(KEY, undefined, () => decryptSecret(sealedV1))).toThrow();
      // A previous key that is wrong too.
      const other = "a1b2c3d4e5f60718".repeat(4);
      expect(() => withKeys(KEY, other, () => decryptSecret(sealedV1))).toThrow();
      expect(() =>
        withKeys(KEY, other, () => decryptSecret(sealedV2, "signer:fund-1:user-1")),
      ).toThrow();
    });

    it("still enforces the v2 binding on the fallback path", () => {
      expect(() =>
        withKeys(KEY, OLD_KEY, () => decryptSecret(sealedV2, "signer:fund-1:user-2")),
      ).toThrow();
      expect(() =>
        withKeys(KEY, OLD_KEY, () => decryptSecret(sealedV2, "signer:fund-2:user-1")),
      ).toThrow();
      expect(() => withKeys(KEY, OLD_KEY, () => decryptSecret(sealedV2))).toThrow(/binding/);
    });

    it("always encrypts with the current key", () => {
      const env = withKeys(KEY, OLD_KEY, () => encryptSecret("fresh", "signer:f:u"));
      // Readable with the current key alone …
      expect(withKeys(KEY, undefined, () => decryptSecret(env, "signer:f:u"))).toBe("fresh");
      // … and not with the previous key alone.
      expect(() => withKeys(OLD_KEY, undefined, () => decryptSecret(env, "signer:f:u"))).toThrow();
    });

    it("rejects a malformed previous key instead of silently skipping it", () => {
      expect(() => withKeys(KEY, "not-hex", () => decryptSecret(sealedV1))).toThrow(
        /APP_CRED_KEY_PREVIOUS/,
      );
    });
  });
});
