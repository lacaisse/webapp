// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Member sessions vs staff routes (plan "Bread card-holder voting", D2): a
// User linked to a Member through Member.userId has NO FundMember row, so
// `requireFundRole` — the gate of every `(fund)` dashboard route — refuses
// it; `requireMember` is the member pages' gate and refuses staff without a
// membership in turn.
vi.mock("server-only", () => ({}));

const nav = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => nav);

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string } } }));
vi.mock("./better-auth", () => ({
  auth: { api: { getSession: async () => session.current } },
}));

const fund = vi.hoisted(() => ({
  current: { id: "fund-1", memberLoginEnabled: true } as { id: string; memberLoginEnabled: boolean },
}));
vi.mock("@/services/fund/server", () => ({ requireCurrentFund: async () => fund.current }));
vi.mock("@/services/host/server", () => ({
  getHostType: async () => "fund",
  getAuthUrl: (p: string) => `http://auth.localhost:3000${p}`,
}));

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  fundMember: { findUnique: vi.fn(), count: vi.fn() },
  member: { findFirst: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { requireFundCreator, requireFundRole, requireMember } from "./dal";

const memberUser = { id: "11111111-1111-4111-8111-111111111111", email: "ada@example.org", globalRole: "USER" };
const staffUser = { id: "22222222-2222-4222-8222-222222222222", email: "staff@example.org", globalRole: "USER" };

beforeEach(() => {
  vi.clearAllMocks();
  fund.current = { id: "fund-1", memberLoginEnabled: true };
  requestHeaders.current = new Headers({ "x-pathname": "/account" });
});

describe("a member session", () => {
  beforeEach(() => {
    session.current = { user: { id: memberUser.id } };
    prisma.user.findUnique.mockResolvedValue(memberUser);
    prisma.fundMember.findUnique.mockResolvedValue(null); // never staff
    prisma.fundMember.count.mockResolvedValue(0);
    prisma.member.findFirst.mockResolvedValue({ id: "m1", fundId: "fund-1", userId: memberUser.id });
  });

  it("cannot create a fund (and so become its OWNER)", async () => {
    await expect(requireFundCreator()).rejects.toThrow("REDIRECT:/unauthorized");
    expect(prisma.fundMember.count).toHaveBeenCalledWith({ where: { userId: memberUser.id } });
  });

  it("never satisfies a staff route, even at the lowest role", async () => {
    await expect(requireFundRole("VIEWER")).rejects.toThrow("REDIRECT:/unauthorized");
    await expect(requireFundRole("OPERATOR")).rejects.toThrow("REDIRECT:/unauthorized");
    expect(prisma.fundMember.findUnique).toHaveBeenCalledWith({
      where: { userId_fundId: { userId: memberUser.id, fundId: "fund-1" } },
    });
  });

  it("passes the member gate with its Member row", async () => {
    const result = await requireMember();
    expect(result.member.id).toBe("m1");
    expect(result.user.id).toBe(memberUser.id);
    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: { fundId: "fund-1", userId: memberUser.id },
    });
  });

  it("is a 404 at a fund that has member login off", async () => {
    fund.current = { id: "fund-1", memberLoginEnabled: false };
    await expect(requireMember()).rejects.toThrow("NOT_FOUND");
  });
});

describe("a staff session", () => {
  beforeEach(() => {
    session.current = { user: { id: staffUser.id } };
    prisma.user.findUnique.mockResolvedValue(staffUser);
    prisma.fundMember.findUnique.mockResolvedValue({ userId: staffUser.id, fundId: "fund-1", role: "OPERATOR" });
    prisma.fundMember.count.mockResolvedValue(1);
    prisma.member.findFirst.mockResolvedValue(null);
  });

  it("passes the staff gate", async () => {
    const result = await requireFundRole("OPERATOR");
    expect(result.membership.role).toBe("OPERATOR");
  });

  it("may create a fund, as may a platform admin with no staff row", async () => {
    expect((await requireFundCreator()).id).toBe(staffUser.id);
    prisma.fundMember.count.mockResolvedValue(0);
    prisma.user.findUnique.mockResolvedValue({ ...staffUser, globalRole: "ADMIN" });
    expect((await requireFundCreator()).id).toBe(staffUser.id);
  });

  it("is sent to the member login when it has no membership here", async () => {
    await expect(requireMember()).rejects.toThrow("REDIRECT:/login?notice=no_membership");
  });
});

describe("no session", () => {
  it("goes to the member login with the current path to come back to", async () => {
    session.current = null;
    requestHeaders.current = new Headers({ "x-pathname": "/account", "x-search": "?tab=security" });
    await expect(requireMember()).rejects.toThrow(
      `REDIRECT:/login?return_to=${encodeURIComponent("/account?tab=security")}`,
    );
  });
});
