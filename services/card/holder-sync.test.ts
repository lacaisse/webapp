// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Card holder sync (services/card/holder-sync.ts): the desired state is
// recomputed from the rows and sent as PUT (attached) or DELETE (detached);
// a 404 from the api is "not deployed" (nothing stamped, logged once); a 2xx
// stamps holderSyncedAt. Idempotent.
vi.mock("server-only", () => ({}));

const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));

const cp = vi.hoisted(() => ({ setCardHolder: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const prisma = vi.hoisted(() => ({
  card: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  fund: { findUnique: vi.fn() },
  member: { findUnique: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { CitizenPayApiError } from "@/services/citizenpay/api";

import {
  desiredHolderState,
  scheduleCardHolderSync,
  syncCardHolder,
  syncFundCardHolders,
  syncMemberCardHolders,
} from "./holder-sync";

const fund = {
  id: "fund-1",
  memberLoginEnabled: true,
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
};
const verified = { userId: "user-1", emailVerifiedAt: new Date("2026-11-01") };
const card = (over: Record<string, unknown> = {}) => ({
  id: "card-1",
  fundId: "fund-1",
  serialNumber: "S1",
  memberId: "m1",
  member: verified,
  enrolledFromRequest: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  prisma.fund.findUnique.mockResolvedValue(fund);
  cp.setCardHolder.mockResolvedValue(undefined);
});

describe("desiredHolderState", () => {
  it("attaches only a verified login at a fund with member login on", () => {
    expect(desiredHolderState(fund, card())).toEqual({ kind: "attached", holderRef: "user-1" });
    expect(desiredHolderState(fund, card({ member: { ...verified, emailVerifiedAt: null } }))).toEqual({ kind: "detached" });
    expect(desiredHolderState(fund, card({ member: { userId: null, emailVerifiedAt: new Date() } }))).toEqual({ kind: "detached" });
    expect(desiredHolderState(fund, card({ memberId: null, member: null }))).toEqual({ kind: "detached" });
    expect(desiredHolderState({ memberLoginEnabled: false }, card())).toEqual({ kind: "detached" });
  });
});

describe("syncCardHolder", () => {
  it("PUTs the holder ref for an attached card and stamps holderSyncedAt", async () => {
    prisma.card.findUnique.mockResolvedValue(card());
    expect(await syncCardHolder("card-1")).toBe("ok");
    expect(cp.setCardHolder).toHaveBeenCalledWith("S1", "user-1");
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { holderSyncedAt: expect.any(Date) },
    });
  });

  it("DELETEs for an unassigned card and for a member whose email is not verified", async () => {
    prisma.card.findUnique.mockResolvedValue(card({ memberId: null, member: null }));
    expect(await syncCardHolder("card-1")).toBe("ok");
    expect(cp.setCardHolder).toHaveBeenLastCalledWith("S1", null);

    prisma.card.findUnique.mockResolvedValue(card({ member: { ...verified, emailVerifiedAt: null } }));
    expect(await syncCardHolder("card-1")).toBe("ok");
    expect(cp.setCardHolder).toHaveBeenLastCalledWith("S1", null);
    expect(prisma.card.update).toHaveBeenCalledTimes(2);
  });

  it("is idempotent: the same state twice sends the same call twice", async () => {
    prisma.card.findUnique.mockResolvedValue(card());
    await syncCardHolder("card-1");
    await syncCardHolder("card-1");
    expect(cp.setCardHolder.mock.calls).toEqual([["S1", "user-1"], ["S1", "user-1"]]);
  });

  it("treats a 404 as 'not deployed': nothing stamped, one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    prisma.card.findUnique.mockResolvedValue(card());
    cp.setCardHolder.mockRejectedValue(new CitizenPayApiError("not found", 404, null));
    expect(await syncCardHolder("card-1")).toBe("not_deployed");
    expect(await syncCardHolder("card-1")).toBe("not_deployed");
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("not deployed"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("reports other failures by code and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    prisma.card.findUnique.mockResolvedValue(card());
    cp.setCardHolder.mockRejectedValue(new CitizenPayApiError("boom", 500, null));
    expect(await syncCardHolder("card-1")).toBe("500");
    cp.setCardHolder.mockRejectedValue(new TypeError("fetch failed"));
    expect(await syncCardHolder("card-1")).toBe("network");
    expect(prisma.card.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("DELETEs for a fund that turned member login off, even with a verified login", async () => {
    prisma.card.findUnique.mockResolvedValue(card());
    prisma.fund.findUnique.mockResolvedValue({ ...fund, memberLoginEnabled: false });
    expect(await syncCardHolder("card-1")).toBe("ok");
    expect(cp.setCardHolder).toHaveBeenLastCalledWith("S1", null);
  });

  it("skips funds without a CP key, enrolled copies and unknown cards", async () => {
    prisma.card.findUnique.mockResolvedValue(card());
    prisma.fund.findUnique.mockResolvedValue({ ...fund, citizenPayApiKeyEnc: null });
    expect(await syncCardHolder("card-1")).toBe("skipped");
    prisma.fund.findUnique.mockResolvedValue(fund);
    prisma.card.findUnique.mockResolvedValue(card({ enrolledFromRequest: { id: "req-1" } }));
    expect(await syncCardHolder("card-1")).toBe("skipped");
    prisma.card.findUnique.mockResolvedValue(null);
    expect(await syncCardHolder("card-1")).toBe("skipped");
    expect(cp.setCardHolder).not.toHaveBeenCalled();
  });
});

describe("syncFundCardHolders (the member-login toggle)", () => {
  it("detaches every card that may have been attached when the flag goes off", async () => {
    prisma.fund.findUnique.mockResolvedValue({ ...fund, memberLoginEnabled: false });
    prisma.card.findMany.mockResolvedValue([card(), card({ id: "card-2", serialNumber: "S2", memberId: null, member: null })]);
    expect(await syncFundCardHolders("fund-1")).toEqual(["ok", "ok"]);
    expect(prisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ member: { userId: { not: null } } }, { holderSyncedAt: { not: null } }],
        }),
      }),
    );
    expect(cp.setCardHolder.mock.calls).toEqual([["S1", null], ["S2", null]]);
  });
});

describe("syncMemberCardHolders / scheduleCardHolderSync", () => {
  it("syncs every card of the member", async () => {
    prisma.member.findUnique.mockResolvedValue({
      fundId: "fund-1",
      cards: [card(), card({ id: "card-2", serialNumber: "S2" })],
    });
    expect(await syncMemberCardHolders("m1")).toEqual(["ok", "ok"]);
    expect(cp.setCardHolder.mock.calls).toEqual([["S1", "user-1"], ["S2", "user-1"]]);
  });

  it("defers the sync behind the response and de-duplicates ids", async () => {
    prisma.card.findUnique.mockResolvedValue(card());
    scheduleCardHolderSync(["card-1", "card-1"]);
    expect(cp.setCardHolder).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(cp.setCardHolder).toHaveBeenCalledTimes(1);
  });
});
