// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /join door's limits: the page lookup never says why a code is unusable
// and only a miss counts per IP; a submit counts per code when it starts and
// per IP only when it ends; the existing-account email goes once per address
// per while.
vi.mock("server-only", () => ({}));

const { requestHeaders, findUnique } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  findUnique: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));
vi.mock("@/services/db/prisma", () => ({
  prisma: { subscriptionWaiverCode: { findUnique } },
}));

import {
  allowExistingAccountEmail,
  allowJoinSubmit,
  countJoinSubmit,
  lookupJoinCode,
} from "./join";

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

  it("lets an address check a usable code as often as it likes (a shared link behind one NAT)", async () => {
    findUnique.mockResolvedValue(activeCode);
    for (let i = 0; i < 60; i++) {
      expect((await lookupJoinCode(activeCode.code)).kind).toBe("ok");
    }
  });

  it("stops answering an address after 30 misses in 10 minutes, whatever the codes were", async () => {
    findUnique.mockResolvedValue(null);
    for (let i = 0; i < 30; i++) {
      expect(await lookupJoinCode(`WRONGCODE${String(i).padStart(3, "0")}`)).toEqual({ kind: "invalid" });
    }
    expect(await lookupJoinCode(activeCode.code)).toEqual({ kind: "too_many" });
    // Another address is unaffected.
    requestFrom(freshIp());
    findUnique.mockResolvedValue(activeCode);
    expect((await lookupJoinCode(activeCode.code)).kind).toBe("ok");
  });
});

describe("allowJoinSubmit / countJoinSubmit", () => {
  it("spends the address's budget only on submits that ended: 10 per hour", async () => {
    for (let i = 0; i < 25; i++) {
      // Starting a submit (a different code each time) never spends it…
      expect(await allowJoinSubmit(`CODE${String(i).padStart(8, "0")}`)).toBe(true);
    }
    for (let i = 0; i < 10; i++) await countJoinSubmit(); // …ending one does.
    expect(await allowJoinSubmit("ANOTHERCODE1")).toBe(false);
    requestFrom(freshIp());
    expect(await allowJoinSubmit("ANOTHERCODE1")).toBe(true);
  });

  it("allows 10 submits per code per 10 minutes across addresses, counted as they start", async () => {
    for (let i = 0; i < 10; i++) {
      requestFrom(freshIp());
      expect(await allowJoinSubmit("SAMECODE0001")).toBe(true);
    }
    requestFrom(freshIp());
    expect(await allowJoinSubmit("SAMECODE0001")).toBe(false);
    expect(await allowJoinSubmit("OTHERCODE001")).toBe(true);
  });

  it("counts a submit without a code against the address only", async () => {
    for (let i = 0; i < 25; i++) expect(await allowJoinSubmit(null)).toBe(true);
    for (let i = 0; i < 10; i++) await countJoinSubmit();
    expect(await allowJoinSubmit(null)).toBe(false);
    expect(await allowJoinSubmit("SOMECODE0001")).toBe(false);
  });
});

describe("allowExistingAccountEmail", () => {
  it("lets one email go per address per 10 minutes", () => {
    expect(allowExistingAccountEmail("alice@example.org")).toBe(true);
    expect(allowExistingAccountEmail("alice@example.org")).toBe(false);
    expect(allowExistingAccountEmail("bob@example.org")).toBe(true);
  });
});
