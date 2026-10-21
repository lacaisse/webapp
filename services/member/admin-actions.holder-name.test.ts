// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Wiring: assigning a card to a member (activation, add-card) schedules the
// CitizenPay holder-name publish. Everything around the action is faked;
// services/card/publish-holder-name.test.ts covers the publish itself.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const fund = vi.hoisted(() => ({
  id: "fund-1",
  name: "Fund",
  domain: "fund.lacaisse.eu",
  citizenPayFundId: "cp-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
  confirmationEmailsPausedAt: new Date(), // no emails in these tests
  referralBonusAmount: null,
  tokenChainId: 100,
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({ fund, user: { id: "u1" } }),
}));

const publish = vi.hoisted(() => ({ scheduleCardHolderNamePublish: vi.fn() }));
vi.mock("@/services/card/publish-holder-name", () => publish);

const cp = vi.hoisted(() => ({ registerCard: vi.fn(), submitMint: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));
vi.mock("@/services/card/notify", () => ({
  dispatchCardAssignedEmail: vi.fn(),
  sendCardAssignedEmailSafe: vi.fn(),
}));
const enrollment = vi.hoisted(() => ({
  findForeignCards: vi.fn(),
  requestCardEnrollment: vi.fn(),
}));
vi.mock("@/services/card/enrollment-requests", () => enrollment);
vi.mock("@/services/card/numbering", () => ({ nextCardNumber: async () => 7 }));
vi.mock("@/services/email/transactional", () => ({
  sendMemberActivated: vi.fn(),
  sendMemberInvited: vi.fn(),
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({ ANNOTATION_TRIGGERS: {} }));
vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation: vi.fn(),
}));

const prisma = vi.hoisted(() => {
  const p = {
    member: { findFirst: vi.fn(), update: vi.fn() },
    card: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    referral: { findUnique: vi.fn() },
    email: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p));
  return p;
});
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { activateMemberAction, addCardAction } from "./admin-actions";

const member = {
  id: "m1",
  email: "jane@example.org",
  firstName: "Jane",
  lastName: "Doe",
  address: null,
  postalCode: null,
  city: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  enrollment.findForeignCards.mockResolvedValue(new Map());
});

describe("activateMemberAction", () => {
  it("schedules the holder-name publish for the assigned card", async () => {
    prisma.member.findFirst.mockResolvedValue({ ...member, status: "NEW", primaryCardId: null });
    prisma.card.findFirst.mockResolvedValue({
      id: "card-1",
      serialNumber: "S1",
      number: 1,
      account: null,
      memberId: null,
      status: "ACTIVE",
      reportedLostAt: null,
    });
    prisma.referral.findUnique.mockResolvedValue(null);

    expect(await activateMemberAction({ memberId: "m1", cardId: "card-1" })).toEqual({ ok: true });
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, "card-1");
  });
});

describe("addCardAction", () => {
  beforeEach(() => {
    prisma.member.findFirst.mockResolvedValue({
      ...member,
      status: "ACTIVE",
      primaryCardId: "card-0",
    });
  });

  it("schedules the publish when linking an existing unattached card", async () => {
    prisma.card.findFirst.mockResolvedValue({
      id: "card-2",
      fundId: "fund-1",
      serialNumber: "S2",
      number: 2,
      memberId: null,
      status: "ACTIVE",
      reportedLostAt: null,
    });
    prisma.card.update.mockResolvedValue({ id: "card-2", serialNumber: "S2", number: 2 });

    expect(await addCardAction({ memberId: "m1", cardSerial: "S2", holderName: "Tom Doe" })).toEqual({ ok: true });
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, "card-2");
  });

  it("schedules the publish for a newly registered card", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    cp.registerCard.mockResolvedValue({ account: "0xabc" });
    prisma.card.create.mockResolvedValue({ id: "card-3", serialNumber: "S3", number: 7 });

    expect(await addCardAction({ memberId: "m1", cardSerial: "S3" })).toEqual({ ok: true });
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, "card-3");
  });

  it("files an enrollment request for a serial issued by another fund", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    const foreign = {
      id: "card-x",
      fundId: "fund-2",
      serialNumber: "S9",
      fund: { id: "fund-2", name: "Other Fund", domain: "other.lacaisse.eu" },
    };
    enrollment.findForeignCards.mockResolvedValue(new Map([["S9", foreign]]));
    enrollment.requestCardEnrollment.mockResolvedValue({ id: "req-1", status: "PENDING" });

    expect(await addCardAction({ memberId: "m1", cardSerial: "s9", holderName: "Tom Doe" })).toEqual({
      ok: true,
      requested: { fundName: "Other Fund" },
    });
    expect(prisma.card.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fundId: "fund-1", serialNumber: { equals: "S9", mode: "insensitive" } },
      }),
    );
    expect(enrollment.findForeignCards).toHaveBeenCalledWith("fund-1", ["S9"]);
    expect(enrollment.requestCardEnrollment).toHaveBeenCalledWith({
      requesterFund: { id: "fund-1", name: "Fund", domain: "fund.lacaisse.eu" },
      requestedById: "u1",
      card: foreign,
      memberId: "m1",
      holderName: "Tom Doe",
    });
    expect(cp.registerCard).not.toHaveBeenCalled();
    expect(prisma.card.create).not.toHaveBeenCalled();
    expect(publish.scheduleCardHolderNamePublish).not.toHaveBeenCalled();
  });

  it("still links an unattached own-fund row without filing a request", async () => {
    prisma.card.findFirst.mockResolvedValue({
      id: "card-4",
      serialNumber: "S4",
      number: 4,
      memberId: null,
      status: "INACTIVE",
      reportedLostAt: null,
    });
    prisma.card.update.mockResolvedValue({ id: "card-4", serialNumber: "S4", number: 4 });

    expect(await addCardAction({ memberId: "m1", cardSerial: "S4" })).toEqual({ ok: true });
    expect(prisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "card-4" },
        data: { memberId: "m1", holderName: "Jane Doe", formerMemberId: null },
      }),
    );
    expect(enrollment.findForeignCards).not.toHaveBeenCalled();
    expect(enrollment.requestCardEnrollment).not.toHaveBeenCalled();
    expect(cp.registerCard).not.toHaveBeenCalled();
  });

  it("rejects a serial bound to another member of this fund", async () => {
    prisma.card.findFirst.mockResolvedValue({
      id: "card-5",
      serialNumber: "S5",
      number: 5,
      memberId: "m2",
      status: "ACTIVE",
      reportedLostAt: null,
    });

    expect(await addCardAction({ memberId: "m1", cardSerial: "S5" })).toEqual({
      error: "members.admin.errors.serialTaken",
    });
    expect(enrollment.requestCardEnrollment).not.toHaveBeenCalled();
  });
});
