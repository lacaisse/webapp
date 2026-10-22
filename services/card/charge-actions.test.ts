// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// chargeCardAction turns Citizen Pay's answer into what the dialog acts on:
// 428 → ask for the PIN; a refusal we name → its key (the dialog branches on
// the key, never on the translated text) with the order the api names; a
// sentence we do not know → shown as sent; a call that never answered →
// "unknown", safe to retry. An order is charged only on the chosen
// merchant's place.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => `t:${key}`,
}));

const fund = vi.hoisted(() => ({
  id: "fund-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({ fund, user: { id: "u1" } }),
}));

const cp = vi.hoisted(() => ({
  listOpenPlaceOrders: vi.fn(),
  chargeCardForOrder: vi.fn(),
  chargeCardOnPlace: vi.fn(),
}));
vi.mock("@/services/citizenpay/client", () => ({
  getCitizenPayClient: () => cp,
}));

const prisma = vi.hoisted(() => ({
  card: { findFirst: vi.fn() },
  merchant: { findFirst: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { CitizenPayApiError } from "@/services/citizenpay/api";

import { chargeCardAction } from "./charge-actions";

const card = {
  id: "c1",
  serialNumber: "04A1B2C3D4E5F6",
  status: "ACTIVE",
  memberId: null,
};
const merchant = { id: "m1", citizenPayPlaceId: "place-1" };
const manual = {
  cardId: "c1",
  merchantId: "m1",
  orderId: null,
  amountCents: 1250,
  description: "Lunch",
  pinHash: null,
  idempotencyKey: "key-0001-abcd",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  prisma.card.findFirst.mockResolvedValue(card);
  prisma.merchant.findFirst.mockResolvedValue(merchant);
  cp.listOpenPlaceOrders.mockResolvedValue([{ id: 42, totalCents: 500 }]);
});

describe("chargeCardAction", () => {
  it("asks for the PIN on 428", async () => {
    cp.chargeCardOnPlace.mockRejectedValue(
      new CitizenPayApiError("card pin required", 428, {
        error: "card pin required",
      }),
    );
    expect(await chargeCardAction(manual)).toEqual({
      ok: false,
      pinRequired: true,
    });
  });

  it("names a refusal by key and passes the order the api names through", async () => {
    cp.chargeCardOnPlace.mockRejectedValue(
      new CitizenPayApiError("insufficient card balance", 402, {
        error: "insufficient card balance",
        orderId: 77,
        orderStatus: "pending",
        retry: "/v2/treasury/orders/77/charge-card",
      }),
    );
    expect(await chargeCardAction(manual)).toEqual({
      ok: false,
      pinRequired: false,
      error: "t:cards.admin.charge.errors.insufficient",
      errorKey: "cards.admin.charge.errors.insufficient",
      orderId: 77,
      orderStatus: "pending",
    });
  });

  it("shows a sentence it does not know as sent, with no key", async () => {
    cp.chargeCardOnPlace.mockRejectedValue(
      new CitizenPayApiError(
        "charge outcome unknown: the transfer may have been sent",
        502,
        {
          error: "charge outcome unknown: the transfer may have been sent",
          orderId: 78,
          orderStatus: "confirming",
          txHash: "0xabc",
        },
      ),
    );
    expect(await chargeCardAction(manual)).toMatchObject({
      ok: false,
      error: "charge outcome unknown: the transfer may have been sent",
      errorKey: null,
      orderId: 78,
      orderStatus: "confirming",
    });
  });

  it("answers 'unknown' when the call itself failed", async () => {
    cp.chargeCardOnPlace.mockRejectedValue(new Error("fetch failed"));
    expect(await chargeCardAction(manual)).toMatchObject({
      ok: false,
      errorKey: "cards.admin.charge.errors.unknown",
      orderId: null,
    });
  });

  it("charges an open order of the merchant's place, and refuses one that is not", async () => {
    cp.chargeCardForOrder.mockResolvedValue({
      orderId: 42,
      txHash: "0xdead",
      status: "paid",
      settled: true,
      existing: false,
    });
    const input = {
      ...manual,
      orderId: 42,
      amountCents: null,
      description: null,
    };
    expect(await chargeCardAction(input)).toEqual({
      ok: true,
      orderId: 42,
      txHash: "0xdead",
      settled: true,
      existing: false,
    });
    expect(cp.chargeCardForOrder).toHaveBeenCalledWith(42, {
      serialNumber: card.serialNumber,
      pinHash: null,
    });

    cp.chargeCardForOrder.mockClear();
    expect(await chargeCardAction({ ...input, orderId: 43 })).toMatchObject({
      ok: false,
      errorKey: "cards.admin.charge.errors.orderNotFound",
    });
    expect(cp.chargeCardForOrder).not.toHaveBeenCalled();
  });

  it("refuses a blocked card and a merchant without a place before calling CP", async () => {
    prisma.card.findFirst.mockResolvedValue({ ...card, status: "BLOCKED" });
    expect(await chargeCardAction(manual)).toMatchObject({
      errorKey: "cards.admin.charge.errors.cardBlocked",
    });
    prisma.card.findFirst.mockResolvedValue(card);
    prisma.merchant.findFirst.mockResolvedValue({
      id: "m1",
      citizenPayPlaceId: null,
    });
    expect(await chargeCardAction(manual)).toMatchObject({
      errorKey: "cards.admin.charge.errors.merchantNotFound",
    });
    expect(cp.chargeCardOnPlace).not.toHaveBeenCalled();
  });
});
