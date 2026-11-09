// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The events handler's dispatch: `topup.*` settles the one order through the
// top-up runner (mocked here), `card.*` keeps re-reading the card.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  settleTopUpOrderNow: vi.fn(),
  cardFindFirst: vi.fn(),
  getCitizenPayCard: vi.fn(),
  applyRemoteCardState: vi.fn(),
}));

vi.mock("@/services/topup-orders/run", () => ({
  settleTopUpOrderNow: mocks.settleTopUpOrderNow,
}));

vi.mock("@/services/db/prisma", () => ({
  prisma: { card: { findFirst: mocks.cardFindFirst } },
}));

vi.mock("@/services/card/pin-block", () => ({
  RECONCILABLE_CARD_SELECT: {},
  applyRemoteCardState: mocks.applyRemoteCardState,
  resolvePlaceName: vi.fn(async () => null),
}));

vi.mock("./client", () => ({
  getCitizenPayClient: () => ({ getCitizenPayCard: mocks.getCitizenPayCard }),
}));

import {
  CitizenPayEventPayloadSchema,
  handleCitizenPayEvent,
  type EventFund,
} from "./events";

const fund: EventFund = {
  id: "f1",
  name: "Fund",
  domain: "fund.lacaisse.eu",
  timezone: "Europe/Brussels",
  primaryColor: null,
  logoUrl: null,
  senderEmail: null,
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "enc",
  citizenPayEventsSecretEnc: "enc",
  citizenPayTreasurySlug: "fund",
};

function topUp(overrides: Record<string, unknown> = {}) {
  return CitizenPayEventPayloadSchema.parse({
    id: "topup-42-pending",
    type: "topup.pending",
    project: "fund",
    order_id: 42,
    serial: "",
    account: "0xacc",
    amount: 1250,
    token: "0xtoken",
    state: "pending",
    at: "2026-11-09T10:00:00Z",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleCitizenPayEvent — topup.*", () => {
  it("accepts an account top-up's empty serial", () => {
    expect(topUp().serial).toBe("");
  });

  it.each([
    ["minted", "APPLIED", "minted"],
    ["reversed", "APPLIED", "reversed"],
    ["reported", "APPLIED", "reported"],
    ["not_listed", "IGNORED", "not listed by Citizen Pay (already settled, or not this fund's)"],
    ["cannot_mint", "IGNORED", "fund cannot mint"],
  ])("settles the order now and maps %s", async (kind, outcome, detail) => {
    mocks.settleTopUpOrderNow.mockResolvedValue({ kind });
    const result = await handleCitizenPayEvent(fund, topUp());
    expect(mocks.settleTopUpOrderNow).toHaveBeenCalledWith("f1", 42);
    expect(result).toEqual({ outcome, detail });
  });

  it("maps a skip with its reason, and takes a reversal by its string order id", async () => {
    mocks.settleTopUpOrderNow.mockResolvedValue({ kind: "skipped", reason: "42: in_flight" });
    const result = await handleCitizenPayEvent(
      fund,
      topUp({
        id: "topup-42-reversal",
        type: "topup.reversal_pending",
        order_id: "42",
        state: "reversal_pending",
      }),
    );
    expect(mocks.settleTopUpOrderNow).toHaveBeenCalledWith("f1", 42);
    expect(result).toEqual({ outcome: "IGNORED", detail: "skipped: 42: in_flight" });
  });

  it("ignores a top-up event without an order id", async () => {
    const result = await handleCitizenPayEvent(fund, topUp({ order_id: null }));
    expect(result).toEqual({ outcome: "IGNORED", detail: "no order id" });
    expect(mocks.settleTopUpOrderNow).not.toHaveBeenCalled();
  });

  it("ignores a top-up event for a fund no longer connected", async () => {
    const result = await handleCitizenPayEvent(
      { ...fund, citizenPayApiKeyEnc: null },
      topUp(),
    );
    expect(result.outcome).toBe("IGNORED");
    expect(mocks.settleTopUpOrderNow).not.toHaveBeenCalled();
  });

  it("lets a settle failure propagate (the route records FAILED, the api redelivers)", async () => {
    mocks.settleTopUpOrderNow.mockRejectedValue(new Error("list pending: 502"));
    await expect(handleCitizenPayEvent(fund, topUp())).rejects.toThrow(/502/);
  });
});

describe("handleCitizenPayEvent — card.*", () => {
  it("still re-reads the card and applies that read", async () => {
    const card = { id: "c1", serialNumber: "SER1" };
    mocks.cardFindFirst.mockResolvedValue(card);
    mocks.getCitizenPayCard.mockResolvedValue({
      status: "blocked",
      pinBlockedAt: new Date("2026-11-09T10:00:00Z"),
      pinEvents: [],
    });
    mocks.applyRemoteCardState.mockResolvedValue({
      transition: { kind: "none" },
      notified: null,
    });

    const result = await handleCitizenPayEvent(
      fund,
      CitizenPayEventPayloadSchema.parse({ id: 7, type: "card.blocked", serial: "SER1" }),
    );
    expect(mocks.getCitizenPayCard).toHaveBeenCalledWith("SER1");
    expect(mocks.applyRemoteCardState).toHaveBeenCalled();
    expect(result).toEqual({ outcome: "IGNORED", detail: "already in sync" });
    expect(mocks.settleTopUpOrderNow).not.toHaveBeenCalled();
  });

  it("ignores a card event with an empty serial", async () => {
    const result = await handleCitizenPayEvent(
      fund,
      CitizenPayEventPayloadSchema.parse({ id: 8, type: "card.blocked", serial: "" }),
    );
    expect(result).toEqual({ outcome: "IGNORED", detail: "no serial on the event" });
  });
});
