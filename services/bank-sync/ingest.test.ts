// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// ingestTopUpDeposit, through the cron entry point: a "cp-<id>" deposit is
// handled before member matching — linked as CARD_TOPUP, or held unmatched
// for review — and never reaches matchMember / the tier mint.

vi.mock("server-only", () => ({}));

const prisma = vi.hoisted(() => ({
  bankTransaction: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  fund: { findUnique: vi.fn(), update: vi.fn() },
  member: { findUnique: vi.fn(async () => null) },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const cp = vi.hoisted(() => ({ listBankTransactions: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const topUps = vi.hoisted(() => ({
  claimTopUpDeposit: vi.fn(),
  linkTopUpDeposit: vi.fn(),
}));
vi.mock("@/services/card-topup/settle", () => topUps);

const matching = vi.hoisted(() => ({ matchMember: vi.fn() }));
vi.mock("./matching/match", () => matching);
const allocate = vi.hoisted(() => ({ mintTierAllocation: vi.fn() }));
vi.mock("./allocate", () => allocate);
vi.mock("@/services/allocation-periods/ensure", () => ({
  ensureOpenPeriod: vi.fn(async () => "period-1"),
  ensurePeriodForDate: vi.fn(async () => "period-1"),
}));
vi.mock("@/services/member/eligibility", () => ({ isAllocationEligible: () => true }));
vi.mock("@/services/email/transactional", () => ({
  sendPaymentBelowMinimum: vi.fn(),
  sendPaymentConfirmation: vi.fn(),
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({
  ANNOTATION_TRIGGERS: { bankSync: "BANK_SYNC" },
}));

import { syncFundBankTransactions } from "./ingest";

const fund = {
  id: "fund-1",
  name: "Caisse",
  citizenPayFundId: "treasury-1",
  citizenPayApiKeyId: null,
  citizenPayApiKeyEnc: null,
  tokenChainId: 100,
  citizenPayLastSyncedAt: null,
  allocationMode: "PAY_AND_GO" as const,
  allocationCutoffDay: 31,
  confirmationEmailsPausedAt: null,
  primaryColor: null,
  logoUrl: null,
  senderEmail: null,
};

const deposit = {
  externalId: "ext-1",
  direction: "INCOMING" as const,
  amount: "12.50",
  currency: "EUR",
  occurredAt: "2026-10-20",
  counterpartIban: "BE68539007547034", // a learned IBAN would tier-mint
  remittanceInfo: "cp-501",
};

beforeEach(() => {
  vi.clearAllMocks();
  cp.listBankTransactions.mockResolvedValue({ transactions: [deposit] });
  prisma.bankTransaction.findUnique.mockResolvedValue(null);
  prisma.bankTransaction.create.mockResolvedValue({ id: "btx-1" });
  prisma.fund.findUnique.mockResolvedValue({ ...fund, tokenDecimals: 6 });
  matching.matchMember.mockResolvedValue({
    memberId: "member-1",
    status: "ACTIVE",
    tierId: "tier-1",
    account: "0xcard",
    cardId: null,
    method: "IBAN",
  });
});

describe("ingest: open-banking top-up deposits", () => {
  it("links a cp-<id> deposit as CARD_TOPUP and skips member matching", async () => {
    topUps.claimTopUpDeposit.mockResolvedValue({
      kind: "topup",
      topUpId: "topup-1",
      cardId: "card-1",
      memberId: "member-1",
    });
    topUps.linkTopUpDeposit.mockResolvedValue({ linked: true, minted: true });

    const stats = await syncFundBankTransactions(fund);

    expect(topUps.claimTopUpDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "fund-1" }),
      { paymentRequestId: 501, amount: "12.50", live: true, bankTransactionId: null },
    );
    expect(prisma.bankTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        externalId: "ext-1",
        matchMethod: "CARD_TOPUP",
        cardId: "card-1",
        memberId: "member-1",
        allocationPeriodId: null,
      }),
      select: { id: true },
    });
    expect(topUps.linkTopUpDeposit).toHaveBeenCalledWith(
      expect.anything(),
      "topup-1",
      "btx-1",
      true,
    );
    expect(matching.matchMember).not.toHaveBeenCalled();
    expect(allocate.mintTierAllocation).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ ingested: 1, matched: 1, minted: 1 });
  });

  it("holds a mismatched top-up deposit unmatched, with a note, and never tier-mints it", async () => {
    topUps.claimTopUpDeposit.mockResolvedValue({
      kind: "hold",
      reason: "amount_mismatch",
      note: "Card top-up cp-501: deposit 12.50 differs",
    });

    const stats = await syncFundBankTransactions(fund);

    expect(prisma.bankTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        externalId: "ext-1",
        notes: "Card top-up cp-501: deposit 12.50 differs",
      }),
    });
    const data = prisma.bankTransaction.create.mock.calls[0][0].data;
    expect(data.matchedAt).toBeUndefined();
    expect(data.matchMethod).toBeUndefined();
    expect(topUps.linkTopUpDeposit).not.toHaveBeenCalled();
    expect(matching.matchMember).not.toHaveBeenCalled();
    expect(allocate.mintTierAllocation).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ ingested: 1, matched: 0, minted: 0 });
  });

  it("un-matches the row when another deposit was linked to the top-up first", async () => {
    topUps.claimTopUpDeposit.mockResolvedValue({
      kind: "topup",
      topUpId: "topup-1",
      cardId: "card-1",
      memberId: "member-1",
    });
    topUps.linkTopUpDeposit.mockResolvedValue({ linked: false, minted: false });

    await syncFundBankTransactions(fund);

    expect(prisma.bankTransaction.update).toHaveBeenCalledWith({
      where: { id: "btx-1" },
      data: expect.objectContaining({ matchedAt: null, matchMethod: null }),
    });
    expect(matching.matchMember).not.toHaveBeenCalled();
  });

  it("falls through to regular matching for a deposit that isn't a top-up", async () => {
    cp.listBankTransactions.mockResolvedValue({
      transactions: [{ ...deposit, remittanceInfo: "cotisation octobre" }],
    });
    await syncFundBankTransactions(fund);
    expect(topUps.claimTopUpDeposit).not.toHaveBeenCalled();
    expect(matching.matchMember).toHaveBeenCalled();
  });
});
