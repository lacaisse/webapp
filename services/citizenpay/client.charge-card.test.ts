// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The in-memory dev client follows Citizen Pay's charge-card rules closely
// enough that the admin charge-on-card dialog behaves in dev as it will live:
// a PIN round trip, a refusal after the order was created that names the
// order, an idempotent retry, and a sale that drops out of the open list once
// paid.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));

import { CitizenPayApiError } from "./api";
import { getCitizenPayClient } from "./client";

const fund = { id: "f1", citizenPayApiKeyId: null, citizenPayApiKeyEnc: null };
let n = 0;
const freshPlace = () => `mock-place-charge-${++n}`;

async function refusal(p: Promise<unknown>): Promise<CitizenPayApiError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CitizenPayApiError);
  return e as CitizenPayApiError;
}

beforeEach(() => {
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mock client charge-card", () => {
  it("lists a place's uncollected sales and drops one once a card paid it", async () => {
    const c = getCitizenPayClient(fund);
    const place = freshPlace();
    const open = await c.listOpenPlaceOrders(place);
    expect(open.length).toBe(2);
    expect(open[0].createdAt >= open[1].createdAt).toBe(true);

    const paid = await c.chargeCardForOrder(open[0].id, {
      serialNumber: "04A1B2C3",
      pinHash: null,
    });
    expect(paid).toMatchObject({
      orderId: open[0].id,
      status: "paid",
      settled: true,
      existing: false,
    });
    expect(paid.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await c.listOpenPlaceOrders(place)).map((o) => o.id)).toEqual([
      open[1].id,
    ]);

    const again = await refusal(
      c.chargeCardForOrder(open[0].id, {
        serialNumber: "04A1B2C3",
        pinHash: null,
      }),
    );
    expect(again.status).toBe(409);
    expect(again.message).toBe("order already paid");
  });

  it("asks for the PIN on a card that has one, then pays with the digest", async () => {
    const c = getCitizenPayClient(fund);
    const [order] = await c.listOpenPlaceOrders(freshPlace());
    const e = await refusal(
      c.chargeCardForOrder(order.id, { serialNumber: "04PIN", pinHash: null }),
    );
    expect(e.status).toBe(428);
    const paid = await c.chargeCardForOrder(order.id, {
      serialNumber: "04PIN",
      pinHash: "ab".repeat(32),
    });
    expect(paid.status).toBe("paid");
  });

  it("creates the order before a card that cannot cover it refuses, and names it", async () => {
    const c = getCitizenPayClient(fund);
    const place = freshPlace();
    const e = await refusal(
      c.chargeCardOnPlace(place, {
        serialNumber: "04POOR",
        pinHash: null,
        amountCents: 1500,
        description: "Lunch",
        idempotencyKey: "key-poor-0001",
      }),
    );
    expect(e.status).toBe(402);
    const body = e.body as {
      orderId: number;
      orderStatus: string;
      retry: string;
    };
    expect(body.orderStatus).toBe("pending");
    expect(body.retry).toBe(`/v2/treasury/orders/${body.orderId}/charge-card`);
    // The created sale is now one of the place's open orders…
    const open = await c.listOpenPlaceOrders(place);
    expect(open.find((o) => o.id === body.orderId)).toMatchObject({
      totalCents: 1500,
      description: "Lunch",
    });
    // …and another card pays it through the order route.
    const paid = await c.chargeCardForOrder(body.orderId, {
      serialNumber: "04OK",
      pinHash: null,
    });
    expect(paid.orderId).toBe(body.orderId);
  });

  it("answers a retried idempotency key with the charge the first attempt made", async () => {
    const c = getCitizenPayClient(fund);
    const place = freshPlace();
    const input = {
      serialNumber: "04OK",
      pinHash: null,
      amountCents: 480,
      description: null,
      idempotencyKey: "key-retry-0001",
    };
    const first = await c.chargeCardOnPlace(place, input);
    expect(first.existing).toBe(false);
    const second = await c.chargeCardOnPlace(place, input);
    expect(second).toMatchObject({
      orderId: first.orderId,
      status: "paid",
      existing: true,
    });
    // Nothing new is open on the place beyond the seeded sales.
    expect((await c.listOpenPlaceOrders(place)).length).toBe(2);
  });

  it("refuses a blocked card or a lost badge before anything is created", async () => {
    const c = getCitizenPayClient(fund);
    const place = freshPlace();
    for (const [serial, status, message] of [
      ["04BLOCKED", 403, "card is blocked"],
      ["04LOST", 403, "badge lost"],
    ] as const) {
      const e = await refusal(
        c.chargeCardOnPlace(place, {
          serialNumber: serial,
          pinHash: null,
          amountCents: 100,
          description: null,
          idempotencyKey: `key-${serial}`,
        }),
      );
      expect([e.status, e.message]).toEqual([status, message]);
    }
    expect((await c.listOpenPlaceOrders(place)).length).toBe(2);
  });
});
