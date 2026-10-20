// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Wiring: unassigning a card, and pushing a local card to CitizenPay, schedule
// the holder-name publish. services/card/publish-holder-name.test.ts covers
// the publish itself.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const fund = vi.hoisted(() => ({
  id: "fund-1",
  citizenPayFundId: "cp-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({ fund, user: { id: "u1" } }),
}));

const publish = vi.hoisted(() => ({ scheduleCardHolderNamePublish: vi.fn() }));
vi.mock("@/services/card/publish-holder-name", () => publish);

const cp = vi.hoisted(() => ({ registerCard: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));
vi.mock("@/services/token/userop", () => ({
  burnFromToken: vi.fn(),
  mintToken: vi.fn(),
  UserOpError: class UserOpError extends Error {},
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({ ANNOTATION_TRIGGERS: {} }));
vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation: vi.fn(),
}));
vi.mock("./sync", () => ({ computeCardSyncPlan: vi.fn() }));

const prisma = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), update: vi.fn() },
  member: { updateMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { pushOneCardAction, unassignCardAction } from "./admin-actions";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("unassignCardAction", () => {
  it("schedules the publish (which resets the name) after unassigning", async () => {
    prisma.card.findFirst.mockResolvedValue({ id: "card-1", memberId: "m1" });
    expect(await unassignCardAction({ cardId: "card-1" })).toEqual({ ok: true });
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { memberId: null, formerMemberId: "m1" },
    });
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, "card-1");
  });

  it("does not publish when the card wasn't assigned", async () => {
    prisma.card.findFirst.mockResolvedValue({ id: "card-1", memberId: null });
    await unassignCardAction({ cardId: "card-1" });
    expect(publish.scheduleCardHolderNamePublish).not.toHaveBeenCalled();
  });
});

describe("pushOneCardAction", () => {
  it("schedules the publish after registering the card on CitizenPay", async () => {
    prisma.card.findFirst.mockResolvedValue({
      id: "card-1",
      serialNumber: "S1",
      account: "0xabc",
      holderName: null,
      member: { firstName: "Jane", lastName: "Doe" },
    });
    cp.registerCard.mockResolvedValue({ account: "0xabc" });
    expect(await pushOneCardAction({ cardId: "card-1" })).toEqual({ ok: true });
    expect(cp.registerCard).toHaveBeenCalledWith(
      expect.objectContaining({ serialNumber: "S1", holderName: "Jane Doe" }),
    );
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, "card-1");
  });
});
