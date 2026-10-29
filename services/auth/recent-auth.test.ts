// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  RECENT_AUTH_MAX_AGE_MS,
  recentAuthCookieName,
  sessionRef,
  signRecentAuthProof,
  verifyRecentAuthProof,
} from "./recent-auth";

const secret = "test-secret-at-least-32-characters-long";
const user = "6f0d6c9e-3a9e-4f1c-9c2e-2a0f1f3f7c11";
const token = "session-token-abc";
const host = "caisse-test.localhost:3029";
const now = 1_800_000_000_000;

function proof(overrides: Partial<Parameters<typeof signRecentAuthProof>[0]> = {}, s = secret) {
  return signRecentAuthProof(
    { sub: user, sid: sessionRef(token), host, iat: now, method: "password", ...overrides },
    s,
  );
}

const ok = { secret, userId: user, sessionToken: token, host, now };

describe("verifyRecentAuthProof", () => {
  it("accepts a fresh proof bound to the same user, session and host", () => {
    const claims = verifyRecentAuthProof(proof(), ok);
    expect(claims).not.toBeNull();
    expect(claims!.method).toBe("password");
    expect(claims!.sub).toBe(user);
  });

  it("accepts a proof right up to the freshness window and rejects it after", () => {
    expect(verifyRecentAuthProof(proof(), { ...ok, now: now + RECENT_AUTH_MAX_AGE_MS })).not.toBeNull();
    expect(verifyRecentAuthProof(proof(), { ...ok, now: now + RECENT_AUTH_MAX_AGE_MS + 1 })).toBeNull();
  });

  it("honours a caller-supplied freshness window", () => {
    expect(verifyRecentAuthProof(proof(), { ...ok, now: now + 5_000, maxAgeMs: 4_000 })).toBeNull();
    expect(verifyRecentAuthProof(proof(), { ...ok, now: now + 3_000, maxAgeMs: 4_000 })).not.toBeNull();
  });

  it("rejects a proof issued too far in the future", () => {
    expect(verifyRecentAuthProof(proof({ iat: now + 120_000 }), ok)).toBeNull();
    expect(verifyRecentAuthProof(proof({ iat: now + 30_000 }), ok)).not.toBeNull();
  });

  it("rejects another user's proof", () => {
    expect(verifyRecentAuthProof(proof({ sub: "someone-else" }), ok)).toBeNull();
  });

  it("rejects a proof issued for another session of the same user", () => {
    expect(verifyRecentAuthProof(proof(), { ...ok, sessionToken: "other-session" })).toBeNull();
  });

  it("rejects a proof issued on another host", () => {
    expect(verifyRecentAuthProof(proof(), { ...ok, host: "other.localhost:3029" })).toBeNull();
  });

  it("rejects a proof signed with another secret, a tampered payload or garbage", () => {
    expect(verifyRecentAuthProof(proof({}, "another-secret"), ok)).toBeNull();
    const [payload, sig] = proof().split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), sub: "x" }),
    ).toString("base64url");
    expect(verifyRecentAuthProof(`${forged}.${sig}`, ok)).toBeNull();
    expect(verifyRecentAuthProof("", ok)).toBeNull();
    expect(verifyRecentAuthProof(null, ok)).toBeNull();
    expect(verifyRecentAuthProof("no-dot", ok)).toBeNull();
    expect(verifyRecentAuthProof(".sig", ok)).toBeNull();
    expect(verifyRecentAuthProof(proof(), { ...ok, secret: "" })).toBeNull();
  });

  it("rejects well-signed claims of the wrong shape", () => {
    const bad = Buffer.from(JSON.stringify({ v: 2, sub: user })).toString("base64url");
    const sig = signRecentAuthProof({ sub: user, sid: "", host, iat: now, method: "passkey" }, secret)
      .split(".")[1];
    expect(verifyRecentAuthProof(`${bad}.${sig}`, ok)).toBeNull();
  });
});

describe("recentAuthCookieName", () => {
  it("uses the __Secure- prefix only for secure cookies", () => {
    expect(recentAuthCookieName(true)).toBe("__Secure-la-caisse.reauth");
    expect(recentAuthCookieName(false)).toBe("la-caisse.reauth");
  });
});

describe("sessionRef", () => {
  it("is stable and never exposes the token", () => {
    expect(sessionRef(token)).toBe(sessionRef(token));
    expect(sessionRef(token)).not.toContain(token);
    expect(sessionRef(token)).not.toBe(sessionRef("other"));
  });
});
