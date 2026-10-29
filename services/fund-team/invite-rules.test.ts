// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { inviteAcceptCheck, inviteTokenFromReturnTo } from "./invite-rules";

const sent = new Date("2026-10-29T10:00:00Z");
const before = new Date("2026-10-28T10:00:00Z");
const after = new Date("2026-10-29T11:00:00Z");

describe("inviteAcceptCheck", () => {
  it("refuses an unverified account that predates the invite", () => {
    expect(
      inviteAcceptCheck({
        user: { emailVerified: false, createdAt: before },
        invite: { createdAt: sent },
        requireEmailVerification: false,
      }),
    ).toBe("unverified_preexisting");
  });

  it("accepts an unverified account created after the invite (it came through the invite sign-up)", () => {
    expect(
      inviteAcceptCheck({
        user: { emailVerified: false, createdAt: after },
        invite: { createdAt: sent },
        requireEmailVerification: false,
      }),
    ).toBe("ok");
  });

  it("accepts a verified account whatever its age", () => {
    expect(
      inviteAcceptCheck({
        user: { emailVerified: true, createdAt: before },
        invite: { createdAt: sent },
        requireEmailVerification: false,
      }),
    ).toBe("ok");
  });

  it("is moot once email verification is enforced at sign-in", () => {
    expect(
      inviteAcceptCheck({
        user: { emailVerified: false, createdAt: before },
        invite: { createdAt: sent },
        requireEmailVerification: true,
      }),
    ).toBe("ok");
  });
});

describe("inviteTokenFromReturnTo", () => {
  it("reads the token of a join-team URL", () => {
    expect(
      inviteTokenFromReturnTo("https://acme.lacaisse.eu/join-team?token=abc%2Fdef"),
    ).toBe("abc/def");
    expect(inviteTokenFromReturnTo("http://caisse-test.localhost:3029/join-team?token=t1")).toBe(
      "t1",
    );
  });

  it("rejects anything else", () => {
    expect(inviteTokenFromReturnTo(undefined)).toBeNull();
    expect(inviteTokenFromReturnTo("")).toBeNull();
    expect(inviteTokenFromReturnTo("https://acme.lacaisse.eu/dashboard")).toBeNull();
    expect(inviteTokenFromReturnTo("https://acme.lacaisse.eu/join-team")).toBeNull();
    expect(inviteTokenFromReturnTo("https://acme.lacaisse.eu/join-team?token=")).toBeNull();
    expect(inviteTokenFromReturnTo("/join-team?token=abc")).toBeNull();
    expect(inviteTokenFromReturnTo("not a url")).toBeNull();
  });
});
