// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { decryptSecret, encryptSecret, envelopeVersion } from "./secret";

const KEY = "0123456789abcdef".repeat(4);
let saved: string | undefined;

beforeAll(() => {
  saved = process.env.APP_CRED_KEY;
  process.env.APP_CRED_KEY = KEY;
});
afterAll(() => {
  if (saved === undefined) delete process.env.APP_CRED_KEY;
  else process.env.APP_CRED_KEY = saved;
});

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
});
