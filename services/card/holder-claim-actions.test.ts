// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The fund's decisions on wallet claims and the ADMIN detach: confirm and
// refuse go to the api first and record the decision with the acting user;
// detach is ADMIN + step-up, unbinds locally first (so the api's
// card.detached webhook finds nothing to do) and rolls back when the api
// fails — except on a 404, where nothing was attached at the api.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const auth = vi.hoisted(() => ({
  requireFundRole: vi.fn(),
  hasRecentAuth: vi.fn(),
}));
vi.mock("@/services/auth/dal", () => ({ requireFundRole: auth.requireFundRole }));
vi.mock("@/services/auth/step-up", () => ({ hasRecentAuth: auth.hasRecentAuth }));

const cp = vi.hoisted(() => ({
  confirmCardHolder: vi.fn(),
  refuseCardHolder: vi.fn(),
  setCardHolder: vi.fn(),
  getCitizenPayCard: vi.fn(),
}));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const prisma = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  member: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  cardEvent: { create: vi.fn(), delete: vi.fn() },
  cardHolderClaim: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const apiSync = vi.hoisted(() => ({ scheduleMemberApiSync: vi.fn() }));
vi.mock("@/services/member/api-sync", () => apiSync);
const publish = vi.hoisted(() => ({ scheduleCardHolderNamePublish: vi.fn() }));
vi.mock("./publish-holder-name", () => publish);
vi.mock("./holder-claim-emails", () => ({ sendCardClaimedFromWalletEmails: vi.fn() }));
vi.mock("./numbering", () => ({ nextCardNumber: vi.fn(async () => 9) }));

import { CitizenPayApiError } from "@/services/citizenpay/api";

import {
  confirmCardHolderClaimAction,
  detachCardHolderAction,
  refuseCardHolderClaimAction,
} from "./holder-claim-actions";

const LOGIN = "11111111-2222-3333-4444-555555555555";
const fund = {
  id: "fund-1",
  memberLoginEnabled: true,
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
};
const user = { id: "aaaaaaaa-1111-1111-1111-111111111111" };
const claim = {
  id: "claim-1",
  status: "PENDING",
  serial: "SER1",
  holderRef: LOGIN,
  cardId: "card-1",
  member: { id: "m1", userId: LOGIN, emailVerifiedAt: new Date("2026-10-01T00:00:00Z") },
};
const unboundCard = {
  id: "card-1",
  serialNumber: "SER1",
  holderName: null,
  memberId: null,
  formerMemberId: null,
  member: null,
};
const boundCard = {
  id: "card-1",
  serialNumber: "SER1",
  memberId: "m1",
  formerMemberId: "m-older",
  member: { id: "m1", userId: LOGIN },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireFundRole.mockResolvedValue({ fund, user });
  auth.hasRecentAuth.mockResolvedValue(true);
  prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  prisma.cardHolderClaim.findFirst.mockResolvedValue(claim);
  prisma.cardHolderClaim.update.mockResolvedValue({});
  prisma.cardHolderClaim.updateMany.mockResolvedValue({ count: 1 });
  prisma.card.findFirst.mockResolvedValue(unboundCard);
  prisma.card.update.mockResolvedValue({});
  prisma.member.updateMany.mockResolvedValue({ count: 0 });
  prisma.member.update.mockResolvedValue({});
  prisma.cardEvent.create.mockResolvedValue({ id: "ev-1" });
  prisma.cardEvent.delete.mockResolvedValue({});
  cp.confirmCardHolder.mockResolvedValue(undefined);
  cp.refuseCardHolder.mockResolvedValue(undefined);
  cp.setCardHolder.mockResolvedValue(undefined);
});

describe("confirmCardHolderClaimAction", () => {
  it("requires OPERATOR and looks the claim up in the current fund", async () => {
    await confirmCardHolderClaimAction({ claimId: "claim-1" });
    expect(auth.requireFundRole).toHaveBeenCalledWith("OPERATOR");
    expect(prisma.cardHolderClaim.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "claim-1", fundId: "fund-1" } }),
    );
  });

  it("refuses a claim that is not found or not pending", async () => {
    prisma.cardHolderClaim.findFirst.mockResolvedValueOnce(null);
    expect(await confirmCardHolderClaimAction({ claimId: "x" })).toEqual({
      error: "cards.admin.holderClaims.errors.notFound",
    });
    prisma.cardHolderClaim.findFirst.mockResolvedValueOnce({ ...claim, status: "REFUSED" });
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.notPending",
    });
    expect(cp.confirmCardHolder).not.toHaveBeenCalled();
  });

  it("refuses when the member's login is gone or no longer the claimant's", async () => {
    prisma.cardHolderClaim.findFirst.mockResolvedValueOnce({
      ...claim,
      member: { ...claim.member, userId: null },
    });
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.loginRemoved",
    });
    prisma.cardHolderClaim.findFirst.mockResolvedValueOnce({
      ...claim,
      member: { ...claim.member, emailVerifiedAt: null },
    });
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.loginRemoved",
    });
    prisma.cardHolderClaim.findFirst.mockResolvedValueOnce({ ...claim, member: null });
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.notMember",
    });
    expect(cp.confirmCardHolder).not.toHaveBeenCalled();
  });

  it("refuses while member login is off at the fund", async () => {
    auth.requireFundRole.mockResolvedValue({ fund: { ...fund, memberLoginEnabled: false }, user });
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.loginDisabled",
    });
    expect(cp.confirmCardHolder).not.toHaveBeenCalled();
  });

  it("maps the api's 404 and 409 answers and writes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cp.confirmCardHolder.mockRejectedValueOnce(new CitizenPayApiError("x", 404, null));
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.apiNotDeployed",
    });
    // 404 `no pending claim`: the claim is gone at the api, the row is stale.
    cp.confirmCardHolder.mockRejectedValueOnce(
      new CitizenPayApiError("x", 404, { error: "no pending claim" }),
    );
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.notPending",
    });
    expect(prisma.cardHolderClaim.updateMany).toHaveBeenCalledWith({
      where: { id: "claim-1", status: "PENDING" },
      data: { status: "SUPERSEDED", decidedAt: expect.any(Date) },
    });
    cp.confirmCardHolder.mockRejectedValueOnce(
      new CitizenPayApiError("x", 409, { error: "legacy_owner" }),
    );
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.legacyOwner",
    });
    cp.confirmCardHolder.mockRejectedValueOnce(
      new CitizenPayApiError("x", 409, { error: "card is attached to another member" }),
    );
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.apiRefused",
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    cp.confirmCardHolder.mockRejectedValueOnce(new Error("timeout"));
    expect(await confirmCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.failed",
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(prisma.cardHolderClaim.update).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it("confirms at the api, then binds the card and records the decision", async () => {
    const res = await confirmCardHolderClaimAction({ claimId: "claim-1" });
    expect(res).toEqual({ ok: true });
    expect(cp.confirmCardHolder).toHaveBeenCalledWith("SER1", LOGIN);
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { memberId: "m1", formerMemberId: null },
    });
    expect(cp.confirmCardHolder.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.card.update.mock.invocationCallOrder[0],
    );
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "CLAIM_CONFIRMED",
        source: "ADMIN",
        actorUserId: user.id,
        detail: "confirmed",
      }),
      select: { id: true },
    });
    expect(prisma.cardHolderClaim.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: {
        status: "CONFIRMED",
        decidedAt: expect.any(Date),
        decidedById: user.id,
        cardId: "card-1",
      },
    });
    expect(apiSync.scheduleMemberApiSync).toHaveBeenCalledWith("m1");
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, "card-1");
  });

  it("creates the card row when the fund has none", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    cp.getCitizenPayCard.mockResolvedValue(null);
    prisma.card.create.mockResolvedValue({ ...unboundCard, id: "card-new" });
    const res = await confirmCardHolderClaimAction({ claimId: "claim-1" });
    expect(res).toEqual({ ok: true });
    expect(prisma.card.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fundId: "fund-1", serialNumber: "SER1", number: 9 }),
      select: expect.any(Object),
    });
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-new" },
      data: { memberId: "m1", formerMemberId: null },
    });
  });

  it("only records the decision when the api's webhook already bound the card", async () => {
    prisma.card.findFirst.mockResolvedValue({ ...unboundCard, memberId: "m1" });
    const res = await confirmCardHolderClaimAction({ claimId: "claim-1" });
    expect(res).toEqual({ ok: true });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "CLAIM_CONFIRMED" }),
      select: { id: true },
    });
  });
});

describe("refuseCardHolderClaimAction", () => {
  it("refuses this login's claim at the api (never DELETE …/holder), then marks it REFUSED with the decider and the audit line", async () => {
    const res = await refuseCardHolderClaimAction({ claimId: "claim-1" });
    expect(res).toEqual({ ok: true });
    expect(auth.requireFundRole).toHaveBeenCalledWith("OPERATOR");
    expect(cp.refuseCardHolder).toHaveBeenCalledWith("SER1", LOGIN);
    expect(cp.setCardHolder).not.toHaveBeenCalled();
    expect(prisma.cardHolderClaim.updateMany).toHaveBeenCalledWith({
      where: { id: "claim-1", status: { in: ["PENDING", "SUPERSEDED"] } },
      data: { status: "REFUSED", decidedAt: expect.any(Date), decidedById: user.id },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cardId: "card-1",
        kind: "CLAIM_REFUSED",
        source: "ADMIN",
        actorUserId: user.id,
      }),
      select: { id: true },
    });
  });

  it("tolerates a 404, fails on anything else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    cp.refuseCardHolder.mockRejectedValueOnce(
      new CitizenPayApiError("x", 404, { error: "no pending claim" }),
    );
    expect(await refuseCardHolderClaimAction({ claimId: "claim-1" })).toEqual({ ok: true });
    cp.refuseCardHolder.mockRejectedValueOnce(new CitizenPayApiError("x", 500, null));
    prisma.cardHolderClaim.updateMany.mockClear();
    expect(await refuseCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.failed",
    });
    expect(prisma.cardHolderClaim.updateMany).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it("refuses a claim that is not pending", async () => {
    prisma.cardHolderClaim.findFirst.mockResolvedValueOnce({ ...claim, status: "CONFIRMED" });
    expect(await refuseCardHolderClaimAction({ claimId: "claim-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.notPending",
    });
    expect(cp.refuseCardHolder).not.toHaveBeenCalled();
  });
});

describe("detachCardHolderAction", () => {
  beforeEach(() => {
    prisma.card.findFirst.mockResolvedValue(boundCard);
  });

  it("requires ADMIN", async () => {
    await detachCardHolderAction({ cardId: "card-1" });
    expect(auth.requireFundRole).toHaveBeenCalledWith("ADMIN");
  });

  it("refuses a card not bound to a member with a login, before the step-up", async () => {
    prisma.card.findFirst.mockResolvedValueOnce({ ...boundCard, member: { id: "m1", userId: null } });
    expect(await detachCardHolderAction({ cardId: "card-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.notAttached",
    });
    prisma.card.findFirst.mockResolvedValueOnce({ ...boundCard, memberId: null, member: null });
    expect(await detachCardHolderAction({ cardId: "card-1" })).toEqual({
      error: "cards.admin.holderClaims.errors.notAttached",
    });
    expect(auth.hasRecentAuth).not.toHaveBeenCalled();
    expect(cp.setCardHolder).not.toHaveBeenCalled();
  });

  it("asks for the step-up and writes nothing without a fresh re-authentication", async () => {
    auth.hasRecentAuth.mockResolvedValue(false);
    const res = await detachCardHolderAction({ cardId: "card-1" });
    expect(res).toEqual({ error: "auth.errors.reauthRequired", code: "reauth_required" });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(prisma.cardEvent.create).not.toHaveBeenCalled();
    expect(cp.setCardHolder).not.toHaveBeenCalled();
  });

  it("unbinds locally, then detaches at the api", async () => {
    const res = await detachCardHolderAction({ cardId: "card-1" });
    expect(res).toEqual({ ok: true });
    expect(prisma.card.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "card-1" },
      data: { memberId: null, formerMemberId: "m1" },
    });
    expect(prisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", primaryCardId: "card-1" },
      data: { primaryCardId: null },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "HOLDER_DETACHED",
        source: "ADMIN",
        actorUserId: user.id,
      }),
      select: { id: true },
    });
    expect(cp.setCardHolder).toHaveBeenCalledWith("SER1", null);
    expect(prisma.card.update.mock.invocationCallOrder[0]).toBeLessThan(
      cp.setCardHolder.mock.invocationCallOrder[0],
    );
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, "card-1");
    expect(apiSync.scheduleMemberApiSync).toHaveBeenCalledWith("m1");
    expect(prisma.cardEvent.delete).not.toHaveBeenCalled();
  });

  it("rolls the unbind back when the api fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    prisma.member.updateMany.mockResolvedValue({ count: 1 });
    cp.setCardHolder.mockRejectedValue(new CitizenPayApiError("boom", 500, null));
    const res = await detachCardHolderAction({ cardId: "card-1" });
    expect(res).toEqual({ error: "cards.admin.holderClaims.errors.failed" });
    expect(prisma.card.update).toHaveBeenLastCalledWith({
      where: { id: "card-1" },
      data: { memberId: "m1", formerMemberId: "m-older" },
    });
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { primaryCardId: "card-1" },
    });
    expect(prisma.cardEvent.delete).toHaveBeenCalledWith({ where: { id: "ev-1" } });
    expect(apiSync.scheduleMemberApiSync).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("keeps the unbind on a 404 (nothing attached at the api)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cp.setCardHolder.mockRejectedValue(new CitizenPayApiError("nope", 404, null));
    const res = await detachCardHolderAction({ cardId: "card-1" });
    expect(res).toEqual({ ok: true });
    expect(prisma.card.update).toHaveBeenCalledTimes(1);
    expect(prisma.cardEvent.delete).not.toHaveBeenCalled();
    expect(apiSync.scheduleMemberApiSync).toHaveBeenCalledWith("m1");
    warn.mockRestore();
  });
});
