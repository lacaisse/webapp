// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  parseEventsTimestamp,
  signEventsPayload,
  verifyEventsSignature,
} from "./events-signature";

const secret = "0123456789abcdef0123456789abcdef";
const body = '{"id":"evt_1","type":"card.blocked","serial":"ABC"}';
const now = new Date("2026-11-03T10:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));

describe("signEventsPayload", () => {
  it("is HMAC-SHA256 over timestamp + '.' + body, hex", () => {
    const sig = signEventsPayload(secret, ts, body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // A different timestamp or body changes the digest.
    expect(signEventsPayload(secret, "1", body)).not.toBe(sig);
    expect(signEventsPayload(secret, ts, body + " ")).not.toBe(sig);
  });
});

describe("parseEventsTimestamp", () => {
  it("reads unix seconds, unix milliseconds and RFC 3339", () => {
    expect(parseEventsTimestamp(ts)?.toISOString()).toBe(now.toISOString());
    expect(parseEventsTimestamp(String(now.getTime()))?.toISOString()).toBe(
      now.toISOString(),
    );
    expect(parseEventsTimestamp(now.toISOString())?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("answers null for nothing readable", () => {
    expect(parseEventsTimestamp(null)).toBeNull();
    expect(parseEventsTimestamp("")).toBeNull();
    expect(parseEventsTimestamp("yesterday")).toBeNull();
  });
});

describe("verifyEventsSignature", () => {
  const good = () => ({
    secret,
    timestamp: ts,
    signature: signEventsPayload(secret, ts, body),
    rawBody: body,
    now,
  });

  it("accepts a fresh, matching signature (with or without sha256=)", () => {
    expect(verifyEventsSignature(good())).toBe("ok");
    expect(
      verifyEventsSignature({ ...good(), signature: `sha256=${good().signature}` }),
    ).toBe("ok");
    expect(
      verifyEventsSignature({ ...good(), signature: good().signature.toUpperCase() }),
    ).toBe("ok");
  });

  it("refuses a missing header", () => {
    expect(verifyEventsSignature({ ...good(), signature: null })).toBe("missing");
    expect(verifyEventsSignature({ ...good(), timestamp: null })).toBe("missing");
  });

  it("refuses an unreadable timestamp", () => {
    expect(verifyEventsSignature({ ...good(), timestamp: "soon" })).toBe("bad_timestamp");
  });

  it("refuses a timestamp more than five minutes away, either side", () => {
    const old = String(Math.floor(now.getTime() / 1000) - 301);
    expect(
      verifyEventsSignature({
        ...good(),
        timestamp: old,
        signature: signEventsPayload(secret, old, body),
      }),
    ).toBe("skew");
    const future = String(Math.floor(now.getTime() / 1000) + 301);
    expect(
      verifyEventsSignature({
        ...good(),
        timestamp: future,
        signature: signEventsPayload(secret, future, body),
      }),
    ).toBe("skew");
    const edge = String(Math.floor(now.getTime() / 1000) - 300);
    expect(
      verifyEventsSignature({
        ...good(),
        timestamp: edge,
        signature: signEventsPayload(secret, edge, body),
      }),
    ).toBe("ok");
  });

  it("refuses a wrong secret, a tampered body, a non-hex or short signature", () => {
    expect(verifyEventsSignature({ ...good(), secret: "other" })).toBe("mismatch");
    expect(verifyEventsSignature({ ...good(), rawBody: body.replace("ABC", "ABD") })).toBe(
      "mismatch",
    );
    expect(verifyEventsSignature({ ...good(), signature: "zz" })).toBe("mismatch");
    expect(verifyEventsSignature({ ...good(), signature: "abcd" })).toBe("mismatch");
  });

  it("signs the timestamp as sent, so a replay with a fresh timestamp fails", () => {
    const fresh = String(Math.floor(now.getTime() / 1000) + 10);
    expect(verifyEventsSignature({ ...good(), timestamp: fresh })).toBe("mismatch");
  });
});
