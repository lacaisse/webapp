// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isPinBlocked, planCardStateSync } from "./pin-block-rules";

const now = new Date("2026-11-03T10:00:00Z");
const blockedAtIso = "2026-11-03T09:12:00.000Z";
const blockedAt = new Date(blockedAtIso);

describe("planCardStateSync — the api's PIN block", () => {
  it("imports a PIN block the local row does not carry", () => {
    expect(
      planCardStateSync(
        { status: "ACTIVE", blockedReason: null, blockedAt: null },
        { status: "BLOCKED", pinBlockedAt: blockedAtIso },
        now,
      ),
    ).toEqual({
      kind: "pin_block",
      data: { status: "BLOCKED", blockedReason: "PIN", blockedAt },
    });
  });

  it("never pushes ACTIVE over a PIN block (local ACTIVE, api PIN-blocked → import, not push)", () => {
    const t = planCardStateSync(
      { status: "ACTIVE", blockedReason: null, blockedAt: null },
      { status: "BLOCKED", pinBlockedAt: blockedAtIso },
      now,
    );
    expect(t.kind).toBe("pin_block");
  });

  it("is settled once the local row carries the same PIN block", () => {
    expect(
      planCardStateSync(
        { status: "BLOCKED", blockedReason: "PIN", blockedAt },
        { status: "BLOCKED", pinBlockedAt: blockedAtIso },
        now,
      ),
    ).toEqual({ kind: "none" });
  });

  it("re-imports when the api's block time moved (a second block)", () => {
    const later = "2026-11-03T11:00:00.000Z";
    expect(
      planCardStateSync(
        { status: "BLOCKED", blockedReason: "PIN", blockedAt },
        { status: "BLOCKED", pinBlockedAt: later },
        now,
      ),
    ).toEqual({
      kind: "pin_block",
      data: { status: "BLOCKED", blockedReason: "PIN", blockedAt: new Date(later) },
    });
  });

  it("falls back to now for an unreadable block time", () => {
    const t = planCardStateSync(
      { status: "ACTIVE", blockedReason: null, blockedAt: null },
      { status: "BLOCKED", pinBlockedAt: "not a date" },
      now,
    );
    expect(t).toEqual({
      kind: "pin_block",
      data: { status: "BLOCKED", blockedReason: "PIN", blockedAt: now },
    });
  });

  it("pulls a PIN-blocked local row back to ACTIVE when the api says active (wallet unblock, webhook missed)", () => {
    expect(
      planCardStateSync(
        { status: "BLOCKED", blockedReason: "PIN", blockedAt },
        { status: "ACTIVE", pinBlockedAt: null },
        now,
      ),
    ).toEqual({
      kind: "pin_release",
      data: { status: "ACTIVE", blockedReason: null, blockedAt: null },
    });
  });

  it("turns a PIN-blocked local row into a fund block when the api is blocked without a PIN block", () => {
    expect(
      planCardStateSync(
        { status: "BLOCKED", blockedReason: "PIN", blockedAt },
        { status: "BLOCKED", pinBlockedAt: null },
        now,
      ),
    ).toEqual({
      kind: "pin_release",
      data: { status: "BLOCKED", blockedReason: "FUND", blockedAt },
    });
  });
});

describe("planCardStateSync — fund blocks stay local-authoritative", () => {
  it("pushes a fund block the api does not have", () => {
    expect(
      planCardStateSync(
        { status: "BLOCKED", blockedReason: "FUND", blockedAt },
        { status: "ACTIVE", pinBlockedAt: null },
        now,
      ),
    ).toEqual({ kind: "push" });
  });

  it("pushes a fund block over the api's PIN block (the issuer's block supersedes)", () => {
    expect(
      planCardStateSync(
        { status: "BLOCKED", blockedReason: "FUND", blockedAt },
        { status: "BLOCKED", pinBlockedAt: blockedAtIso },
        now,
      ),
    ).toEqual({ kind: "none" });
    expect(
      planCardStateSync(
        { status: "BLOCKED", blockedReason: "FUND", blockedAt },
        { status: "ACTIVE", pinBlockedAt: blockedAtIso },
        now,
      ),
    ).toEqual({ kind: "push" });
  });

  it("reads a BLOCKED row without a reason (pre-column) as a fund block", () => {
    expect(
      planCardStateSync(
        { status: "BLOCKED", blockedReason: null, blockedAt },
        { status: "BLOCKED", pinBlockedAt: blockedAtIso },
        now,
      ),
    ).toEqual({ kind: "none" });
  });

  it("pushes any other mismatch and leaves matching rows alone", () => {
    expect(
      planCardStateSync(
        { status: "INACTIVE", blockedReason: null, blockedAt: null },
        { status: "ACTIVE", pinBlockedAt: null },
        now,
      ),
    ).toEqual({ kind: "push" });
    expect(
      planCardStateSync(
        { status: "ACTIVE", blockedReason: null, blockedAt: null },
        { status: "ACTIVE", pinBlockedAt: null },
        now,
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("isPinBlocked", () => {
  it("is BLOCKED with reason PIN, nothing else", () => {
    expect(isPinBlocked({ status: "BLOCKED", blockedReason: "PIN" })).toBe(true);
    expect(isPinBlocked({ status: "BLOCKED", blockedReason: "FUND" })).toBe(false);
    expect(isPinBlocked({ status: "BLOCKED", blockedReason: null })).toBe(false);
    expect(isPinBlocked({ status: "ACTIVE", blockedReason: "PIN" })).toBe(false);
  });
});
