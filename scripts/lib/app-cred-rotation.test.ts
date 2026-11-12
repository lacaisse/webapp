// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { decryptSecret, encryptSecret } from "@/services/crypto/secret";

import {
  decryptWith,
  encryptWith,
  parseHexKey,
  rotateEnvelope,
  signerBinding,
} from "./app-cred-rotation";

const OLD_HEX = "fedcba9876543210".repeat(4);
const NEW_HEX = "0123456789abcdef".repeat(4);
const keys = { previous: parseHexKey("old", OLD_HEX), current: parseHexKey("new", NEW_HEX) };

let saved: string | undefined;
let savedPrevious: string | undefined;
beforeAll(() => {
  saved = process.env.APP_CRED_KEY;
  savedPrevious = process.env.APP_CRED_KEY_PREVIOUS;
  delete process.env.APP_CRED_KEY_PREVIOUS;
});
afterAll(() => {
  if (saved === undefined) delete process.env.APP_CRED_KEY;
  else process.env.APP_CRED_KEY = saved;
  if (savedPrevious === undefined) delete process.env.APP_CRED_KEY_PREVIOUS;
  else process.env.APP_CRED_KEY_PREVIOUS = savedPrevious;
});

describe("script cipher copy stays in sync with services/crypto/secret.ts", () => {
  it("opens what the app sealed, and the app opens what the script sealed", () => {
    process.env.APP_CRED_KEY = NEW_HEX;
    const v1 = encryptSecret("0xminter");
    const v2 = encryptSecret("0xsigner", "signer:f:u");
    expect(decryptWith(keys.current, v1)).toBe("0xminter");
    expect(decryptWith(keys.current, v2, "signer:f:u")).toBe("0xsigner");
    expect(() => decryptWith(keys.current, v2, "signer:f:other")).toThrow();

    expect(decryptSecret(encryptWith(keys.current, "a", "v1"))).toBe("a");
    expect(decryptSecret(encryptWith(keys.current, "b", "v2", "x:y"), "x:y")).toBe("b");
    expect(() => decryptSecret(encryptWith(keys.current, "b", "v2", "x:y"), "x:z")).toThrow();
  });

  it("uses the same signer binding as services/safe/signer.ts::signerBinding", () => {
    // signer.ts reaches Prisma at import, so the shape is pinned here instead.
    expect(signerBinding("fund-1", "user-1")).toBe("signer:fund-1:user-1");
  });
});

describe("rotateEnvelope", () => {
  it("reports a row sealed under the new key as current", () => {
    const env = encryptWith(keys.current, "secret", "v1");
    expect(rotateEnvelope(env, keys)).toEqual({ status: "current" });
    const bound = encryptWith(keys.current, "secret", "v2", "signer:f:u");
    expect(rotateEnvelope(bound, keys, "signer:f:u")).toEqual({ status: "current" });
  });

  it("re-encrypts a v1 row under the new key, keeping v1", () => {
    const env = encryptWith(keys.previous, "0xminter", "v1");
    const out = rotateEnvelope(env, keys);
    expect(out.status).toBe("migrate");
    if (out.status !== "migrate") return;
    expect(out.next.startsWith("v1:")).toBe(true);
    expect(out.next).not.toBe(env);
    expect(decryptWith(keys.current, out.next)).toBe("0xminter");
    expect(() => decryptWith(keys.previous, out.next)).toThrow();
    // Second pass: nothing left to do.
    expect(rotateEnvelope(out.next, keys)).toEqual({ status: "current" });
  });

  it("re-encrypts a v2 row under the new key, keeping v2 and its binding", () => {
    const aad = signerBinding("fund-1", "user-1");
    const env = encryptWith(keys.previous, "0xsigner", "v2", aad);
    const out = rotateEnvelope(env, keys, aad);
    expect(out.status).toBe("migrate");
    if (out.status !== "migrate") return;
    expect(out.next.startsWith("v2:")).toBe(true);
    expect(decryptWith(keys.current, out.next, aad)).toBe("0xsigner");
    expect(() => decryptWith(keys.current, out.next, "signer:fund-1:user-2")).toThrow();
    expect(rotateEnvelope(out.next, keys, aad)).toEqual({ status: "current" });
  });

  it("fails rows neither key opens, without leaking anything", () => {
    const other = parseHexKey("x", "a1b2c3d4e5f60718".repeat(4));
    const env = encryptWith(other, "secret", "v1");
    expect(rotateEnvelope(env, keys)).toEqual({
      status: "failed",
      reason: "decrypts with neither key",
    });
    const aad = signerBinding("fund-1", "user-1");
    const bound = encryptWith(keys.previous, "secret", "v2", aad);
    expect(rotateEnvelope(bound, keys, "signer:fund-1:user-2").status).toBe("failed");
    expect(rotateEnvelope(bound, keys).status).toBe("failed");
    expect(rotateEnvelope("v9:zzz", keys).status).toBe("failed");
    expect(rotateEnvelope("v1:AAAA", keys).status).toBe("failed");
  });

  it("refuses a malformed key", () => {
    expect(() => parseHexKey("APP_CRED_KEY", "nope")).toThrow(/APP_CRED_KEY/);
    expect(() => parseHexKey("APP_CRED_KEY", undefined)).toThrow(/APP_CRED_KEY/);
  });
});
