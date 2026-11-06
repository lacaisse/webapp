// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Members at the api (services/member/api-sync.ts): the declaration is
// recomputed from the rows and sent as PUT (declared, with the member's
// issuer cards) or DELETE (undeclared, with a ref to withdraw); a 404 from
// the api is "not deployed" (nothing stamped, logged once); a 2xx stamps
// apiSyncedAt. Idempotent, never throws.
vi.mock("server-only", () => ({}));

const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));

const cp = vi.hoisted(() => ({ setTreasuryMember: vi.fn(), removeTreasuryMember: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const prisma = vi.hoisted(() => ({
  member: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  fund: { findUnique: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { CitizenPayApiError } from "@/services/citizenpay/api";

import {
  desiredMemberApiState,
  scheduleMemberApiSync,
  syncFundMembersAtApi,
  syncMemberAtApi,
} from "./api-sync";

const fund = {
  id: "fund-1",
  memberLoginEnabled: true,
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
};
const issued = (serialNumber: string) => ({ serialNumber, enrolledFromRequest: null });
const member = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  fundId: "fund-1",
  userId: "user-1",
  emailVerifiedAt: new Date("2026-11-01"),
  cards: [issued("S2"), issued("s1")],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  prisma.fund.findUnique.mockResolvedValue(fund);
  cp.setTreasuryMember.mockResolvedValue(undefined);
  cp.removeTreasuryMember.mockResolvedValue(undefined);
});

describe("desiredMemberApiState", () => {
  it("declares only a verified login at a fund with member login on", () => {
    expect(desiredMemberApiState(fund, member())).toEqual({
      kind: "declared",
      holderRef: "user-1",
      cards: ["S1", "S2"],
    });
    expect(desiredMemberApiState(fund, member({ emailVerifiedAt: null }))).toEqual({
      kind: "undeclared",
      holderRef: "user-1",
    });
    expect(desiredMemberApiState(fund, member({ userId: null }))).toEqual({
      kind: "undeclared",
      holderRef: null,
    });
    expect(desiredMemberApiState({ memberLoginEnabled: false }, member())).toEqual({
      kind: "undeclared",
      holderRef: "user-1",
    });
  });

  it("lists the issuer cards only, normalized and sorted", () => {
    const state = desiredMemberApiState(
      fund,
      member({
        cards: [
          issued(" b2 "),
          { serialNumber: "C3", enrolledFromRequest: { id: "req-1" } },
          issued("a1"),
          issued("A1"),
        ],
      }),
    );
    expect(state).toEqual({ kind: "declared", holderRef: "user-1", cards: ["A1", "B2"] });
  });
});

describe("syncMemberAtApi", () => {
  it("PUTs the declaration and stamps apiSyncedAt", async () => {
    prisma.member.findUnique.mockResolvedValue(member());
    expect(await syncMemberAtApi("m1")).toBe("ok");
    expect(cp.setTreasuryMember).toHaveBeenCalledWith("user-1", ["S1", "S2"]);
    expect(cp.removeTreasuryMember).not.toHaveBeenCalled();
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { apiSyncedAt: expect.any(Date) },
    });
  });

  it("DELETEs the removed login's ref once the member row no longer names it", async () => {
    prisma.member.findUnique.mockResolvedValue(member({ userId: null }));
    expect(await syncMemberAtApi("m1", { removedHolderRef: "user-1" })).toBe("ok");
    expect(cp.removeTreasuryMember).toHaveBeenCalledWith("user-1");
    expect(cp.setTreasuryMember).not.toHaveBeenCalled();
    expect(prisma.member.update).toHaveBeenCalledTimes(1);
  });

  it("DELETEs for a login whose email is not verified", async () => {
    prisma.member.findUnique.mockResolvedValue(member({ emailVerifiedAt: null }));
    expect(await syncMemberAtApi("m1")).toBe("ok");
    expect(cp.removeTreasuryMember).toHaveBeenCalledWith("user-1");
  });

  it("skips when there is nothing to undeclare, the fund has no key, or the member is unknown", async () => {
    prisma.member.findUnique.mockResolvedValue(member({ userId: null }));
    expect(await syncMemberAtApi("m1")).toBe("skipped");
    prisma.member.findUnique.mockResolvedValue(member());
    prisma.fund.findUnique.mockResolvedValue({ ...fund, citizenPayApiKeyEnc: null });
    expect(await syncMemberAtApi("m1")).toBe("skipped");
    prisma.member.findUnique.mockResolvedValue(null);
    expect(await syncMemberAtApi("m1")).toBe("skipped");
    expect(cp.setTreasuryMember).not.toHaveBeenCalled();
    expect(cp.removeTreasuryMember).not.toHaveBeenCalled();
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("treats a 404 as 'not deployed': nothing stamped, one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    prisma.member.findUnique.mockResolvedValue(member());
    cp.setTreasuryMember.mockRejectedValue(new CitizenPayApiError("not found", 404, null));
    expect(await syncMemberAtApi("m1")).toBe("not_deployed");
    expect(await syncMemberAtApi("m1")).toBe("not_deployed");
    expect(prisma.member.update).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("not deployed"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("reports other failures by code and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    prisma.member.findUnique.mockResolvedValue(member());
    cp.setTreasuryMember.mockRejectedValue(new CitizenPayApiError("boom", 500, null));
    expect(await syncMemberAtApi("m1")).toBe("500");
    cp.setTreasuryMember.mockRejectedValue(new TypeError("fetch failed"));
    expect(await syncMemberAtApi("m1")).toBe("network");
    prisma.member.findUnique.mockRejectedValue(new Error("db down"));
    expect(await syncMemberAtApi("m1")).toBe("error");
    expect(prisma.member.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is idempotent: the same state twice sends the same call twice", async () => {
    prisma.member.findUnique.mockResolvedValue(member());
    await syncMemberAtApi("m1");
    await syncMemberAtApi("m1");
    expect(cp.setTreasuryMember.mock.calls).toEqual([
      ["user-1", ["S1", "S2"]],
      ["user-1", ["S1", "S2"]],
    ]);
  });
});

describe("syncFundMembersAtApi (the member-login toggle)", () => {
  const where = {
    where: {
      fundId: "fund-1",
      OR: [{ userId: { not: null } }, { apiSyncedAt: { not: null } }],
    },
  };

  it("declares the verified logins when the flag goes on", async () => {
    prisma.member.findMany.mockResolvedValue([
      member(),
      member({ id: "m2", userId: "user-2", emailVerifiedAt: null, cards: [] }),
    ]);
    expect(await syncFundMembersAtApi("fund-1")).toEqual(["ok", "ok"]);
    expect(prisma.member.findMany).toHaveBeenCalledWith(expect.objectContaining(where));
    expect(cp.setTreasuryMember.mock.calls).toEqual([["user-1", ["S1", "S2"]]]);
    expect(cp.removeTreasuryMember.mock.calls).toEqual([["user-2"]]);
  });

  it("withdraws every declaration when the flag goes off", async () => {
    prisma.fund.findUnique.mockResolvedValue({ ...fund, memberLoginEnabled: false });
    prisma.member.findMany.mockResolvedValue([
      member(),
      member({ id: "m2", userId: "user-2", cards: [issued("S9")] }),
    ]);
    expect(await syncFundMembersAtApi("fund-1")).toEqual(["ok", "ok"]);
    expect(cp.setTreasuryMember).not.toHaveBeenCalled();
    expect(cp.removeTreasuryMember.mock.calls).toEqual([["user-1"], ["user-2"]]);
  });
});

describe("scheduleMemberApiSync", () => {
  it("defers the sync behind the response and de-duplicates ids", async () => {
    prisma.member.findUnique.mockResolvedValue(member());
    scheduleMemberApiSync(["m1", "m1"]);
    expect(cp.setTreasuryMember).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(cp.setTreasuryMember).toHaveBeenCalledTimes(1);
  });
});
