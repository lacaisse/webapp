// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /join door's two checks: the page lookup never says why a code is
// unusable and is counted per IP; the submit is counted per IP and per code.
vi.mock("server-only", () => ({}));

const { requestHeaders, findUnique } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  findUnique: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));
vi.mock("@/services/db/prisma", () => ({
  prisma: { subscriptionWaiverCode: { findUnique } },
}));

import { allowJoinSubmit, lookupJoinCode } from "./join";

const activeCode = {
  id: "code-1",
  code: "7K3PM2QX9RTD",
  label: "Contributor: Alice",
  maxUses: 1,
  usedCount: 0,
  expiresAt: null,
  revokedAt: null,
};

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}
function requestFrom(ip: string) {
  requestHeaders.current = new Headers({ "x-forwarded-for": `${ip}, 10.1.1.1` });
}

beforeEach(() => {
  findUnique.mockReset();
  requestFrom(freshIp());
});

describe("lookupJoinCode", () => {
  it("accepts a usable code as typed and answers with its display form and label", async () => {
    findUnique.mockResolvedValue(activeCode);
    expect(await lookupJoinCode(" 7k3p m2qx 9rtd ")).toEqual({
      kind: "ok",
      code: "7K3P-M2QX-9RTD",
      label: "Contributor: Alice",
    });
    expect(findUnique).toHaveBeenCalledWith({ where: { code: "7K3PM2QX9RTD" } });
  });

  it("says 'invalid' and nothing more for a malformed, unknown, revoked, expired or used-up code", async () => {
    expect(await lookupJoinCode("short")).toEqual({ kind: "invalid" });
    expect(findUnique).not.toHaveBeenCalled(); // malformed: no read at all
    for (const row of [
      null,
      { ...activeCode, revokedAt: new Date() },
      { ...activeCode, expiresAt: new Date(Date.now() - 1) },
      { ...activeCode, usedCount: 1 },
    ]) {
      findUnique.mockResolvedValueOnce(row);
      expect(await lookupJoinCode(activeCode.code)).toEqual({ kind: "invalid" });
    }
  });

  it("stops answering an IP after 30 checks in 10 minutes, whatever the codes were", async () => {
    findUnique.mockResolvedValue(activeCode);
    for (let i = 0; i < 30; i++) {
      expect((await lookupJoinCode(activeCode.code)).kind).toBe("ok");
    }
    expect(await lookupJoinCode(activeCode.code)).toEqual({ kind: "too_many" });
    // Another address is unaffected.
    requestFrom(freshIp());
    expect((await lookupJoinCode(activeCode.code)).kind).toBe("ok");
  });
});

describe("allowJoinSubmit", () => {
  it("allows 10 submits per IP per hour", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await allowJoinSubmit(`CODE${i}`.padEnd(12, "0"))).toBe(true);
    }
    expect(await allowJoinSubmit("ANOTHERCODE1")).toBe(false);
  });

  it("allows 10 submits per code per 10 minutes across addresses", async () => {
    for (let i = 0; i < 10; i++) {
      requestFrom(freshIp());
      expect(await allowJoinSubmit("SAMECODE0001")).toBe(true);
    }
    requestFrom(freshIp());
    expect(await allowJoinSubmit("SAMECODE0001")).toBe(false);
    expect(await allowJoinSubmit("OTHERCODE001")).toBe(true);
  });
});
