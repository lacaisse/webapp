// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe";

// A fixed 32-byte hex key so the HMAC is deterministic across runs.
const TEST_KEY = "0".repeat(64);
const OLD_KEY = "1".repeat(64);

describe("unsubscribe token", () => {
  let prevKey: string | undefined;
  let prevPrevious: string | undefined;

  beforeAll(() => {
    prevKey = process.env.APP_CRED_KEY;
    prevPrevious = process.env.APP_CRED_KEY_PREVIOUS;
    process.env.APP_CRED_KEY = TEST_KEY;
    delete process.env.APP_CRED_KEY_PREVIOUS;
  });

  afterAll(() => {
    if (prevKey === undefined) delete process.env.APP_CRED_KEY;
    else process.env.APP_CRED_KEY = prevKey;
    if (prevPrevious === undefined) delete process.env.APP_CRED_KEY_PREVIOUS;
    else process.env.APP_CRED_KEY_PREVIOUS = prevPrevious;
  });

  afterEach(() => {
    process.env.APP_CRED_KEY = TEST_KEY;
    delete process.env.APP_CRED_KEY_PREVIOUS;
  });

  it("round-trips a member id", () => {
    const token = buildUnsubscribeToken("member_abc123");
    expect(verifyUnsubscribeToken(token)).toBe("member_abc123");
  });

  it("embeds the member id verbatim before the signature", () => {
    const token = buildUnsubscribeToken("member_abc123");
    expect(token.startsWith("member_abc123.")).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const token = buildUnsubscribeToken("member_abc123");
    const tampered = `${token}x`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("rejects a swapped member id (signature no longer matches)", () => {
    const token = buildUnsubscribeToken("member_abc123");
    const sig = token.slice(token.lastIndexOf(".") + 1);
    expect(verifyUnsubscribeToken(`member_other.${sig}`)).toBeNull();
  });

  it("rejects malformed tokens without throwing", () => {
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("nodot")).toBeNull();
    expect(verifyUnsubscribeToken(".sigonly")).toBeNull();
    expect(verifyUnsubscribeToken("idonly.")).toBeNull();
  });

  describe("key rotation (APP_CRED_KEY_PREVIOUS)", () => {
    it("still accepts a link signed under the previous key", () => {
      process.env.APP_CRED_KEY = OLD_KEY;
      const oldToken = buildUnsubscribeToken("member_abc123");

      process.env.APP_CRED_KEY = TEST_KEY;
      // Without the previous key the old link is dead …
      expect(verifyUnsubscribeToken(oldToken)).toBeNull();
      // … with it, it keeps working.
      process.env.APP_CRED_KEY_PREVIOUS = OLD_KEY;
      expect(verifyUnsubscribeToken(oldToken)).toBe("member_abc123");
    });

    it("signs new links with the current key only", () => {
      process.env.APP_CRED_KEY_PREVIOUS = OLD_KEY;
      const token = buildUnsubscribeToken("member_abc123");
      delete process.env.APP_CRED_KEY_PREVIOUS;
      expect(verifyUnsubscribeToken(token)).toBe("member_abc123");

      // Not the previous key's signature.
      process.env.APP_CRED_KEY = OLD_KEY;
      expect(verifyUnsubscribeToken(token)).toBeNull();
    });

    it("rejects a tampered signature under either key", () => {
      process.env.APP_CRED_KEY = OLD_KEY;
      const oldToken = buildUnsubscribeToken("member_abc123");
      process.env.APP_CRED_KEY = TEST_KEY;
      process.env.APP_CRED_KEY_PREVIOUS = OLD_KEY;
      expect(verifyUnsubscribeToken(`${oldToken}x`)).toBeNull();
      const sig = oldToken.slice(oldToken.lastIndexOf(".") + 1);
      expect(verifyUnsubscribeToken(`member_other.${sig}`)).toBeNull();
    });

    it("treats a malformed previous key as an invalid link, not a crash", () => {
      process.env.APP_CRED_KEY_PREVIOUS = "nope";
      expect(verifyUnsubscribeToken(buildUnsubscribeToken("member_abc123"))).toBeNull();
    });
  });
});
