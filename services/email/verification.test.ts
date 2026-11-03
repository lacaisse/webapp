// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// consumeVerificationToken's member branch with the member LOGIN link: a
// token bound to a User (EmailVerification.userId) verifies that User and
// links the Member to exactly it — never to whichever User has the address.
vi.mock("server-only", () => ({}));

const prisma = vi.hoisted(() => {
  const p = {
    emailVerification: { findUnique: vi.fn(), update: vi.fn() },
    member: { update: vi.fn() },
    merchant: { update: vi.fn() },
    user: { update: vi.fn() },
    $transaction: vi.fn(),
  };
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p));
  return p;
});
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { consumeVerificationToken } from "./verification";

const future = new Date(Date.now() + 60_000);
const base = {
  token: "tok",
  email: "ada@example.org",
  consumedAt: null,
  expiresAt: future,
  merchant: null,
};

beforeEach(() => vi.clearAllMocks());

describe("consumeVerificationToken — member login link", () => {
  it("links an unlinked member to the token's user and verifies both together", async () => {
    prisma.emailVerification.findUnique.mockResolvedValue({
      ...base,
      member: { id: "m1", email: "ada@example.org", fundId: "f1", userId: null },
      user: { id: "u1", email: "Ada@Example.org" },
    });
    const result = await consumeVerificationToken("tok");
    expect(result).toEqual({ ok: true, entity: "member", memberId: "m1", fundId: "f1", linkedUserId: "u1" });
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { emailVerifiedAt: expect.any(Date), userId: "u1" },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { emailVerified: true } });
  });

  it("confirms a member already linked to that same user", async () => {
    prisma.emailVerification.findUnique.mockResolvedValue({
      ...base,
      member: { id: "m1", email: "ada@example.org", fundId: "f1", userId: "u1" },
      user: { id: "u1", email: "ada@example.org" },
    });
    const result = await consumeVerificationToken("tok");
    expect(result).toMatchObject({ ok: true, linkedUserId: "u1" });
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("does not steal a member linked to another user: the member's address is verified, the token's user is not", async () => {
    prisma.emailVerification.findUnique.mockResolvedValue({
      ...base,
      member: { id: "m1", email: "ada@example.org", fundId: "f1", userId: "u-other" },
      user: { id: "u1", email: "ada@example.org" },
    });
    const result = await consumeVerificationToken("tok");
    expect(result).toMatchObject({ ok: true, linkedUserId: null });
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { emailVerifiedAt: expect.any(Date) },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("a classic /join verification (no user on the token) touches no User", async () => {
    prisma.emailVerification.findUnique.mockResolvedValue({
      ...base,
      member: { id: "m1", email: "ada@example.org", fundId: "f1", userId: null },
      user: null,
    });
    const result = await consumeVerificationToken("tok");
    expect(result).toMatchObject({ ok: true, linkedUserId: null });
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { emailVerifiedAt: expect.any(Date) },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a token whose user no longer has that address", async () => {
    prisma.emailVerification.findUnique.mockResolvedValue({
      ...base,
      member: { id: "m1", email: "ada@example.org", fundId: "f1", userId: null },
      user: { id: "u1", email: "someone-else@example.org" },
    });
    const result = await consumeVerificationToken("tok");
    expect(result).toMatchObject({ ok: true, linkedUserId: null });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
