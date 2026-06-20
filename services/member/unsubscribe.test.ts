// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe";

// A fixed 32-byte hex key so the HMAC is deterministic across runs.
const TEST_KEY = "0".repeat(64);

describe("unsubscribe token", () => {
  let prevKey: string | undefined;

  beforeAll(() => {
    prevKey = process.env.APP_CRED_KEY;
    process.env.APP_CRED_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (prevKey === undefined) delete process.env.APP_CRED_KEY;
    else process.env.APP_CRED_KEY = prevKey;
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
});
