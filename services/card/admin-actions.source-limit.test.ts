// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// setCardSourceLimitAction: role gate, fund scoping, input validation and the
// CitizenPay call. The cap lives on CP only — no local write.
vi.mock("server-only", () => ({}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const fund = vi.hoisted(() => ({
  id: "fund-1",
  citizenPayFundId: "cp-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
}));
const dal = vi.hoisted(() => ({
  requireFundRole: vi.fn(async () => ({ fund, user: { id: "u1" } })),
}));
vi.mock("@/services/auth/dal", () => dal);

const cp = vi.hoisted(() => ({ setCardSourceLimit: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));
vi.mock("@/services/card/publish-holder-name", () => ({
  scheduleCardHolderNamePublish: vi.fn(),
}));
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
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { setCardSourceLimitAction } from "./admin-actions";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.card.findFirst.mockResolvedValue({ id: "card-1", serialNumber: "S1" });
  cp.setCardSourceLimit.mockResolvedValue(undefined);
});

describe("setCardSourceLimitAction", () => {
  it("sets the cap on CitizenPay for a card of the fund (OPERATOR)", async () => {
    expect(await setCardSourceLimitAction({ cardId: "card-1", limitCents: 1000 })).toEqual({
      ok: true,
    });
    expect(dal.requireFundRole).toHaveBeenCalledWith("OPERATOR");
    expect(prisma.card.findFirst).toHaveBeenCalledWith({
      where: { id: "card-1", fundId: "fund-1" },
      select: { id: true, serialNumber: true },
    });
    expect(cp.setCardSourceLimit).toHaveBeenCalledWith("S1", 1000);
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(cache.revalidatePath).toHaveBeenCalledWith("/cards");
    expect(cache.revalidatePath).toHaveBeenCalledWith("/cards/card-1");
  });

  it.each([[null], [0]])("clears the cap for %j", async (limitCents) => {
    expect(await setCardSourceLimitAction({ cardId: "card-1", limitCents })).toEqual({ ok: true });
    expect(cp.setCardSourceLimit).toHaveBeenCalledWith("S1", null);
  });

  it.each([[-1], [10.5], [1_000_001], [Number.NaN]])(
    "rejects %j without calling CitizenPay",
    async (limitCents) => {
      expect(await setCardSourceLimitAction({ cardId: "card-1", limitCents })).toEqual({
        error: "cards.admin.source.errors.limitInvalid",
      });
      expect(cp.setCardSourceLimit).not.toHaveBeenCalled();
    },
  );

  it("accepts the 1,000,000-cent ceiling", async () => {
    await setCardSourceLimitAction({ cardId: "card-1", limitCents: 1_000_000 });
    expect(cp.setCardSourceLimit).toHaveBeenCalledWith("S1", 1_000_000);
  });

  it("refuses a card outside the fund", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    expect(await setCardSourceLimitAction({ cardId: "other", limitCents: 1000 })).toEqual({
      error: "cards.admin.source.errors.notFound",
    });
    expect(cp.setCardSourceLimit).not.toHaveBeenCalled();
  });

  it("translates a CitizenPay failure and skips revalidation", async () => {
    cp.setCardSourceLimit.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await setCardSourceLimitAction({ cardId: "card-1", limitCents: 1000 })).toEqual({
      error: "cards.admin.source.errors.limitFailed",
    });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});
