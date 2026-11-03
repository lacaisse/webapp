// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The explicit unblock: ADMIN only, refused on anything but a PIN-blocked
// card, step-up before anything is written, then the local row and the audit
// line with the acting user BEFORE the api's `unblock: true` PATCH (so the
// api's own card.unblocked webhook finds nothing to do), rolled back when the
// api refuses or cannot be reached.
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

const cp = vi.hoisted(() => ({ unblockCardPin: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const prisma = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), update: vi.fn() },
  cardEvent: { create: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { CitizenPayApiError } from "@/services/citizenpay/api";

import { unblockCardPinAction } from "./pin-block-actions";

const fund = { id: "fund-1", citizenPayApiKeyId: "0xkey", citizenPayApiKeyEnc: "v1:enc" };
const user = { id: "11111111-1111-1111-1111-111111111111" };
const blockedAt = new Date("2026-11-03T09:12:00.000Z");
const pinBlockedCard = {
  id: "card-1",
  serialNumber: "SER1",
  status: "BLOCKED",
  blockedReason: "PIN",
  blockedAt,
  memberId: "m1",
};
const rollback = {
  where: { id: "card-1" },
  data: { status: "BLOCKED", blockedReason: "PIN", blockedAt },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireFundRole.mockResolvedValue({ fund, user });
  auth.hasRecentAuth.mockResolvedValue(true);
  prisma.card.findFirst.mockResolvedValue(pinBlockedCard);
  prisma.card.update.mockResolvedValue({});
  prisma.cardEvent.create.mockResolvedValue({ id: "ev-1" });
  prisma.cardEvent.delete.mockResolvedValue({});
  cp.unblockCardPin.mockResolvedValue(undefined);
});

describe("unblockCardPinAction", () => {
  it("requires ADMIN", async () => {
    await unblockCardPinAction({ cardId: "card-1" });
    expect(auth.requireFundRole).toHaveBeenCalledWith("ADMIN");
  });

  it("refuses a card that is not PIN-blocked, before the step-up", async () => {
    prisma.card.findFirst.mockResolvedValue({ ...pinBlockedCard, blockedReason: "FUND" });
    const res = await unblockCardPinAction({ cardId: "card-1" });
    expect(res).toEqual({ error: "cards.admin.pinBlock.errors.notPinBlocked" });
    expect(auth.hasRecentAuth).not.toHaveBeenCalled();
    expect(cp.unblockCardPin).not.toHaveBeenCalled();
  });

  it("asks for the step-up and writes nothing without a fresh re-authentication", async () => {
    auth.hasRecentAuth.mockResolvedValue(false);
    const res = await unblockCardPinAction({ cardId: "card-1" });
    expect(res).toEqual({ error: "auth.errors.reauthRequired", code: "reauth_required" });
    expect(cp.unblockCardPin).not.toHaveBeenCalled();
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(prisma.cardEvent.create).not.toHaveBeenCalled();
  });

  it("claims the local row and the audit line, then lifts the block at the api", async () => {
    const res = await unblockCardPinAction({ cardId: "card-1" });
    expect(res).toEqual({ ok: true });
    expect(prisma.card.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "card-1" },
      data: { status: "ACTIVE", blockedReason: null, blockedAt: null },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: {
        fundId: "fund-1",
        cardId: "card-1",
        kind: "PIN_UNBLOCKED",
        source: "ADMIN",
        actorUserId: user.id,
      },
      select: { id: true },
    });
    expect(cp.unblockCardPin).toHaveBeenCalledWith("SER1");
    // Local first, api second.
    expect(prisma.card.update.mock.invocationCallOrder[0]).toBeLessThan(
      cp.unblockCardPin.mock.invocationCallOrder[0],
    );
    expect(prisma.cardEvent.delete).not.toHaveBeenCalled();
  });

  it("rolls the claim back when the api refuses (an enrolled fund is not the issuer)", async () => {
    cp.unblockCardPin.mockRejectedValue(new CitizenPayApiError("not the issuer", 409, null));
    const res = await unblockCardPinAction({ cardId: "card-1" });
    expect(res).toEqual({ error: "cards.admin.pinBlock.errors.apiRefused" });
    expect(prisma.card.update).toHaveBeenLastCalledWith(rollback);
    expect(prisma.cardEvent.delete).toHaveBeenCalledWith({ where: { id: "ev-1" } });
  });

  it("rolls the claim back when the api is unreachable", async () => {
    cp.unblockCardPin.mockRejectedValue(new Error("timeout"));
    const res = await unblockCardPinAction({ cardId: "card-1" });
    expect(res).toEqual({ error: "cards.admin.pinBlock.errors.failed" });
    expect(prisma.card.update).toHaveBeenLastCalledWith(rollback);
    expect(prisma.cardEvent.delete).toHaveBeenCalledWith({ where: { id: "ev-1" } });
  });

  it("answers not found for a card of another fund", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    const res = await unblockCardPinAction({ cardId: "card-x" });
    expect(res).toEqual({ error: "cards.admin.errors.notFound" });
  });
});
