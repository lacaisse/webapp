// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// signUpMember (services/member/auth.ts): one User per person, one Member per
// fund. A new address gets User + credential Account + Member (linked, not
// verified) in one transaction; an existing Member gets the User only, and a
// verification row bound to that User — the link happens when it is clicked.
vi.mock("server-only", () => ({}));

const hashed = (p: string) => `scrypt:${p}`;
vi.mock("@/services/auth/better-auth", () => ({
  auth: { $context: Promise.resolve({ password: { hash: async (p: string) => hashed(p) } }) },
}));
const holderSync = vi.hoisted(() => ({ syncMemberCardHolders: vi.fn() }));
vi.mock("@/services/card/holder-sync", () => holderSync);
const emails = vi.hoisted(() => ({ sendMemberLoginVerification: vi.fn() }));
vi.mock("@/services/email/transactional", () => emails);
const core = vi.hoisted(() => ({
  resolveMemberSignup: vi.fn(),
  isUniqueViolationOn: (e: unknown, field: string) =>
    (e as { code?: string; meta?: { target?: string[] } }).code === "P2002" &&
    Boolean((e as { meta?: { target?: string[] } }).meta?.target?.some((t) => t.includes(field))),
}));
vi.mock("./signup-core", () => core);

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  users: [] as Row[],
  accounts: [] as Row[],
  members: [] as Row[],
  verifications: [] as Row[],
  emails: [] as Row[],
  referrals: [] as Row[],
  fundMembers: [] as Row[],
}));

const prisma = vi.hoisted(() => {
  const p = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { email: { equals: string } } }) =>
        db.users.find((u) => (u.email as string).toLowerCase() === where.email.equals.toLowerCase()) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `user-${db.users.length + 1}`, ...data };
        db.users.push(row);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        db.users = db.users.filter((u) => u.id !== where.id);
      }),
    },
    account: { create: vi.fn(async ({ data }: { data: Row }) => void db.accounts.push(data)) },
    member: {
      findFirst: vi.fn(async ({ where }: { where: { fundId: string; email?: { equals: string } } }) =>
        db.members.find(
          (m) =>
            m.fundId === where.fundId &&
            (!where.email || (m.email as string).toLowerCase() === where.email.equals.toLowerCase()),
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `member-${db.members.length + 1}`, ...data };
        db.members.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        for (const m of db.members) {
          if (m.id === where.id && m.userId === where.userId) Object.assign(m, data);
        }
      }),
      count: vi.fn(async ({ where }: { where: { userId: string } }) =>
        db.members.filter((m) => m.userId === where.userId).length,
      ),
    },
    fundMember: {
      count: vi.fn(async ({ where }: { where: { userId: string } }) =>
        db.fundMembers.filter((m) => m.userId === where.userId).length,
      ),
    },
    referral: { create: vi.fn(async ({ data }: { data: Row }) => void db.referrals.push(data)) },
    emailVerification: {
      create: vi.fn(async ({ data }: { data: Row }) => void db.verifications.push(data)),
    },
    email: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `email-${db.emails.length + 1}`, ...data };
        db.emails.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(),
  };
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p));
  return p;
});
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { removeMemberLogin, signUpMember } from "./auth";

const fund = {
  id: "fund-1",
  name: "Alpha",
  domain: "alpha.lacaisse.eu",
  allocationMode: "FIXED_PERIOD" as const,
  memberLoginEnabled: true,
  primaryColor: null,
  logoUrl: null,
  senderEmail: null,
};
const input = {
  builtins: { firstName: " Ada ", lastName: "Lovelace", email: "Ada@Example.org" },
  password: "correct horse battery",
  applicationData: { city: "Brussels" },
  referralCode: null,
  locale: "fr",
};
const t = (key: string) => key;

beforeEach(() => {
  vi.clearAllMocks();
  db.users = [];
  db.accounts = [];
  db.members = [];
  db.verifications = [];
  db.emails = [];
  db.referrals = [];
  db.fundMembers = [];
  core.resolveMemberSignup.mockResolvedValue({
    ok: true,
    resolved: {
      contributionAmount: "25.00",
      builtinColumns: { city: "Brussels" },
      applicationData: null,
      sponsor: null,
    },
  });
});

describe("signUpMember — new address", () => {
  it("creates the User, its credential Account and the linked Member in one transaction, then emails the link", async () => {
    const result = await signUpMember(fund, input, t);
    expect(result).toEqual({ ok: true, userId: "user-1", mode: "created" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    expect(db.users).toEqual([
      { id: "user-1", email: "ada@example.org", name: "Ada Lovelace", emailVerified: false },
    ]);
    expect(db.accounts).toEqual([
      { userId: "user-1", providerId: "credential", accountId: "user-1", password: hashed(input.password) },
    ]);
    expect(db.members).toHaveLength(1);
    expect(db.members[0]).toMatchObject({
      fundId: "fund-1",
      userId: "user-1",
      email: "ada@example.org",
      firstName: "Ada",
      lastName: "Lovelace",
      status: "NEW",
      emailVerifiedAt: null,
      contributionAmount: "25.00",
      city: "Brussels",
      locale: "fr",
    });
    expect(db.verifications[0]).toMatchObject({
      memberId: "member-1",
      userId: "user-1",
      email: "ada@example.org",
    });
    expect(db.emails[0]).toMatchObject({ type: "MEMBER_EMAIL_VERIFICATION", memberId: "member-1" });
    expect(emails.sendMemberLoginVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        emailId: "email-1",
        toEmail: "ada@example.org",
        verifyUrl: expect.stringMatching(/^http:\/\/alpha\.localhost:\d+\/verify-email\?token=/),
      }),
    );
  });

  it("refuses when the fund has member login off", async () => {
    expect(await signUpMember({ ...fund, memberLoginEnabled: false }, input, t)).toEqual({
      ok: false,
      error: "disabled",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("hands a form error back untouched", async () => {
    core.resolveMemberSignup.mockResolvedValue({ ok: false, error: "too low", field: "contributionAmount" });
    expect(await signUpMember(fund, input, t)).toEqual({
      ok: false,
      error: "invalid",
      message: "too low",
      field: "contributionAmount",
    });
    expect(db.users).toHaveLength(0);
  });
});

describe("signUpMember — existing Member at the fund", () => {
  beforeEach(() => {
    db.members.push({ id: "member-9", fundId: "fund-1", email: "ADA@example.org", firstName: "Ada", userId: null });
  });

  it("creates the User only and binds the verification to it; the Member waits for the click", async () => {
    const result = await signUpMember(fund, input, t);
    expect(result).toEqual({ ok: true, userId: "user-1", mode: "link" });
    expect(prisma.member.create).not.toHaveBeenCalled();
    // The application answers are the fund's business, not asked nor checked.
    expect(core.resolveMemberSignup).not.toHaveBeenCalled();
    expect(db.referrals).toHaveLength(0);
    expect(db.members[0].userId).toBeNull();
    expect(db.verifications[0]).toMatchObject({
      memberId: "member-9",
      userId: "user-1",
      // The member's stored address, whatever case the visitor typed.
      email: "ADA@example.org",
    });
  });

  it("refuses when that membership already has a login", async () => {
    db.members[0].userId = "user-other";
    expect(await signUpMember(fund, input, t)).toEqual({ ok: false, error: "membership_has_login" });
    expect(db.users).toHaveLength(0);
  });
});

describe("signUpMember — existing User", () => {
  it("refuses: sign in instead (joining another fund with a login is W-2)", async () => {
    db.users.push({ id: "user-7", email: "ada@example.org", emailVerified: true });
    expect(await signUpMember(fund, input, t)).toEqual({ ok: false, error: "account_exists" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("removeMemberLogin", () => {
  beforeEach(() => {
    db.users.push({ id: "user-1", email: "ada@example.org" });
    db.members.push({ id: "member-1", fundId: "fund-1", userId: "user-1" });
  });

  it("clears the link, deletes a User that owns nothing else, and resyncs the member's cards", async () => {
    expect(await removeMemberLogin({ memberId: "member-1", userId: "user-1" })).toEqual({ userDeleted: true });
    expect(db.members[0].userId).toBeNull();
    expect(db.users).toHaveLength(0);
    expect(holderSync.syncMemberCardHolders).toHaveBeenCalledWith("member-1");
  });

  it("keeps a User who is a member elsewhere or staff", async () => {
    db.members.push({ id: "member-2", fundId: "fund-2", userId: "user-1" });
    expect(await removeMemberLogin({ memberId: "member-1", userId: "user-1" })).toEqual({ userDeleted: false });
    expect(db.users).toHaveLength(1);
    expect(db.members.find((m) => m.id === "member-2")?.userId).toBe("user-1");

    db.members = [{ id: "member-1", fundId: "fund-1", userId: "user-1" }];
    db.fundMembers.push({ userId: "user-1", fundId: "fund-3" });
    expect(await removeMemberLogin({ memberId: "member-1", userId: "user-1" })).toEqual({ userDeleted: false });
    expect(db.users).toHaveLength(1);
  });
});
