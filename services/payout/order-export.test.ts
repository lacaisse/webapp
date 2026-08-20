// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { Payout, PayoutOrder, PayoutStatus } from "@/services/citizenpay/types";
import { parseCsv } from "@/services/csv/parse";

import { selectPayoutsForExport } from "./export";
import {
  buildPayoutOrderExportCsv,
  orderSourceLabel,
  orderStatusLabel,
  payoutOrderDate,
  payoutOrderExportFilename,
  PAYOUT_ORDER_EXPORT_COLUMNS,
} from "./order-export";

// Same fixtures as ./export.test.ts: settlement bounds are UTC midnights and
// `endDate` is exclusive, exactly as CitizenPay stores them.
function payout(over: Partial<Payout> & { id: string }): Payout {
  return {
    businessId: "biz-1",
    placeId: "place-1",
    businessName: "Boulangerie SA",
    placeName: "Chez Léa",
    placeImage: null,
    startDate: "2026-07-01T00:00:00Z",
    endDate: "2026-08-01T00:00:00Z",
    totalAmount: "510.00",
    totalFees: "10.00",
    totalPayoutFees: "12.50",
    manualDeduction: "7.50",
    manualDeductionComment: null,
    net: "480.00",
    status: "complete" as PayoutStatus,
    burnTxHashes: [],
    feeTransferPending: false,
    feeTransferTxHash: null,
    pontoPaymentId: null,
    pontoPaymentStatus: null,
    emailRecipient: null,
    emailSentAt: null,
    createdAt: "2026-08-03T09:12:44Z",
    updatedAt: "2026-08-04T11:00:00Z",
    ...over,
  };
}

function order(over: Partial<PayoutOrder> & { id: number }): PayoutOrder {
  return {
    total: "28.32",
    fees: "1.42",
    payoutFee: "0.71",
    net: "26.90",
    due: "0.00",
    status: "paid",
    type: "web",
    processor: null,
    description: "Weekly grocery order",
    items: [],
    txHash: "0xabc",
    account: "0xpayer",
    completedAt: "2026-07-14T10:05:00Z",
    createdAt: "2026-07-14T10:04:30Z",
    ...over,
  };
}

// Identity translator: keys come back as themselves, which keeps the assertions
// about structure rather than about copy.
const t = (key: string) => key;

const range = { from: "2026-07-01", to: "2026-07-31" };
const build = (entries: Parameters<typeof buildPayoutOrderExportCsv>[0]["entries"]) =>
  buildPayoutOrderExportCsv({
    entries,
    range,
    fundDomain: "acme.lacaisse.eu",
    locale: "fr",
    t,
  });

const cell = (row: string[], column: (typeof PAYOUT_ORDER_EXPORT_COLUMNS)[number]) =>
  row[PAYOUT_ORDER_EXPORT_COLUMNS.indexOf(column)];

describe("orderSourceLabel", () => {
  it("names the processor as a brand, identically in every locale", () => {
    expect(orderSourceLabel({ processor: "viva", type: "web" }, t)).toBe("Viva");
    expect(orderSourceLabel({ processor: "stripe", type: "web" }, t)).toBe(
      "Stripe",
    );
    expect(orderSourceLabel({ processor: "ponto", type: "terminal" }, t)).toBe(
      "Ponto",
    );
  });

  it("capitalizes a processor CitizenPay onboarded after us", () => {
    expect(orderSourceLabel({ processor: "mollie", type: "web" }, t)).toBe(
      "Mollie",
    );
    // Already-capitalized spellings survive: only the first letter is forced.
    expect(orderSourceLabel({ processor: "SumUp", type: "web" }, t)).toBe("SumUp");
  });

  it("prefers the processor over the channel when both are known", () => {
    expect(orderSourceLabel({ processor: "viva", type: "terminal" }, t)).toBe(
      "Viva",
    );
  });

  it("localizes the order types CitizenPay emits when no processor handled it", () => {
    for (const type of ["app", "manual", "pos", "terminal", "web"]) {
      expect(orderSourceLabel({ processor: null, type }, t)).toBe(
        `fund.payments.settlement.orderTypes.${type}`,
      );
    }
  });

  it("falls back to the channel on an API deployment without the field", () => {
    // `processor` absent entirely — exactly the pre-field behaviour.
    expect(orderSourceLabel({ type: "web" }, t)).toBe(
      "fund.payments.settlement.orderTypes.web",
    );
    // An empty string is CP saying "none", not a nameless provider.
    expect(orderSourceLabel({ processor: "", type: "app" }, t)).toBe(
      "fund.payments.settlement.orderTypes.app",
    );
  });

  it("prints an unknown future type raw rather than losing it", () => {
    expect(orderSourceLabel({ processor: null, type: "nfc-wristband" }, t)).toBe(
      "nfc-wristband",
    );
    expect(orderSourceLabel({ processor: null, type: null }, t)).toBe("");
  });
});

describe("orderStatusLabel", () => {
  it("localizes the documented statuses and passes anything else through", () => {
    expect(orderStatusLabel("paid", t)).toBe(
      "fund.payments.settlement.orderStatuses.paid",
    );
    expect(orderStatusLabel("refunded", t)).toBe(
      "fund.payments.settlement.orderStatuses.refunded",
    );
    expect(orderStatusLabel("disputed", t)).toBe("disputed");
    expect(orderStatusLabel(null, t)).toBe("");
  });
});

describe("payoutOrderDate", () => {
  it("prefers the completion time but never loses an unsettled order", () => {
    expect(payoutOrderDate(order({ id: 1 }))).toBe("2026-07-14T10:05:00Z");
    expect(payoutOrderDate(order({ id: 2, completedAt: null }))).toBe(
      "2026-07-14T10:04:30Z",
    );
    expect(
      payoutOrderDate(order({ id: 3, completedAt: null, createdAt: null })),
    ).toBe("");
  });
});

describe("payoutOrderExportFilename", () => {
  it("mirrors the recap's naming with its own prefix", () => {
    expect(payoutOrderExportFilename("acme.lacaisse.eu", range)).toBe(
      "payout_orders_acme_2026-07-01_2026-07-31.csv",
    );
    expect(payoutOrderExportFilename("caisse-du-thé!.lacaisse.eu", range)).toBe(
      "payout_orders_caisse-du-the_2026-07-01_2026-07-31.csv",
    );
  });
});

describe("buildPayoutOrderExportCsv", () => {
  it("emits the localized header plus one row per order", () => {
    const file = build([
      { payout: payout({ id: "p1" }), orders: [order({ id: 44790 })] },
    ]);

    expect(file.count).toBe(1);
    expect(file.payoutCount).toBe(1);
    expect(file.filename).toBe("payout_orders_acme_2026-07-01_2026-07-31.csv");

    const parsed = parseCsv(file.csv);
    expect(parsed.headers).toEqual(
      PAYOUT_ORDER_EXPORT_COLUMNS.map(
        (c) => `fund.payments.export.orderColumns.${c}`,
      ),
    );
    expect(parsed.rows[0]).toEqual([
      "2026-07-01",
      "2026-07-31",
      "Chez Léa",
      "Boulangerie SA",
      "p1",
      "fund.payments.settlement.statuses.complete",
      "44790",
      "2026-07-14 10:05",
      "fund.payments.settlement.orderTypes.web",
      "28,32",
      "1,42",
      "0,71",
      "26,90",
      "fund.payments.settlement.orderStatuses.paid",
      "Weekly grocery order",
      "0xabc",
    ]);
  });

  it("repeats the payout context on every row so the file is self-joining", () => {
    const file = build([
      {
        payout: payout({ id: "p1" }),
        orders: [order({ id: 1 }), order({ id: 2 })],
      },
    ]);
    const rows = parseCsv(file.csv).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(cell(r, "reference")).toBe("p1");
      expect(cell(r, "periodStart")).toBe("2026-07-01");
      expect(cell(r, "periodEnd")).toBe("2026-07-31");
      expect(cell(r, "merchant")).toBe("Chez Léa");
    }
  });

  it("nets each order against its processor fees only, never the platform share", () => {
    const file = buildPayoutOrderExportCsv({
      entries: [
        {
          payout: payout({ id: "p1" }),
          orders: [order({ id: 1, total: "28.32", fees: "1.42", payoutFee: "0.71" })],
        },
      ],
      range,
      fundDomain: "acme.lacaisse.eu",
      locale: "en",
      t,
    });
    const r = parseCsv(file.csv).rows[0];
    expect(Number(cell(r, "gross")) - Number(cell(r, "processorFees"))).toBeCloseTo(
      Number(cell(r, "netCredit")),
      2,
    );
    // The platform share rides along as its own column, unsubtracted.
    expect(cell(r, "platformFeeShare")).toBe("0.71");
  });

  it("recomputes the credit in cents rather than trusting the client's net", () => {
    const file = build([
      {
        payout: payout({ id: "p1" }),
        // A stale/incoherent `net` must not reach the accountant's file.
        orders: [order({ id: 1, total: "0.30", fees: "0.10", net: "999.99" })],
      },
    ]);
    expect(cell(parseCsv(file.csv).rows[0], "netCredit")).toBe("0,20");
  });

  it("keeps a fees=0 order (nothing withheld at source) at full credit", () => {
    const file = build([
      {
        payout: payout({ id: "p1" }),
        orders: [order({ id: 1, type: "app", fees: "0.00", total: "12.00" })],
      },
    ]);
    const r = parseCsv(file.csv).rows[0];
    expect(cell(r, "processorFees")).toBe("0,00");
    expect(cell(r, "netCredit")).toBe("12,00");
    expect(cell(r, "source")).toBe("fund.payments.settlement.orderTypes.app");
  });

  it("puts the payment provider in the source column when CitizenPay named one", () => {
    const file = build([
      {
        payout: payout({ id: "p1" }),
        orders: [
          order({ id: 1, type: "web", processor: "viva" }),
          order({ id: 2, type: "terminal", processor: "acme-pay" }),
          // No provider (and no field at all, on an older API) → the channel.
          order({ id: 3, type: "app", processor: null }),
        ],
      },
    ]);
    expect(parseCsv(file.csv).rows.map((r) => cell(r, "source"))).toEqual([
      "Viva",
      "Acme-pay",
      "fund.payments.settlement.orderTypes.app",
    ]);
  });

  it("orders rows oldest first inside a payout, ties broken by id", () => {
    const file = build([
      {
        payout: payout({ id: "p1" }),
        orders: [
          order({ id: 3, completedAt: "2026-07-20T08:00:00Z" }),
          order({ id: 2, completedAt: "2026-07-02T08:00:00Z" }),
          order({ id: 1, completedAt: "2026-07-02T08:00:00Z" }),
        ],
      },
    ]);
    expect(parseCsv(file.csv).rows.map((r) => cell(r, "orderId"))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("keeps the payout order the recap selection produced", () => {
    const june = payout({
      id: "june",
      startDate: "2026-06-01T00:00:00Z",
      endDate: "2026-07-01T00:00:00Z",
    });
    const july = payout({ id: "july", placeId: "place-2", placeName: "Zoé" });
    const selected = selectPayoutsForExport([july, june], {
      from: "2026-06-01",
      to: "2026-07-31",
    });
    const file = build(
      selected.map((p) => ({ payout: p, orders: [order({ id: 1 })] })),
    );
    expect(parseCsv(file.csv).rows.map((r) => cell(r, "reference"))).toEqual([
      "june",
      "july",
    ]);
  });

  it("does not re-filter orders by their own dates — the payout owns the period", () => {
    // CitizenPay pulled an order completed in August into July's payout; the
    // detail file must still carry it, or it stops summing to the recap.
    const file = build([
      {
        payout: payout({ id: "p1" }),
        orders: [order({ id: 1, completedAt: "2026-08-04T09:00:00Z" })],
      },
    ]);
    expect(file.count).toBe(1);
    const r = parseCsv(file.csv).rows[0];
    expect(cell(r, "orderDate")).toBe("2026-08-04 09:00");
    expect(cell(r, "periodStart")).toBe("2026-07-01");
  });

  it("leaves an unsettled order's blanks empty rather than printing null", () => {
    const file = build([
      {
        payout: payout({ id: "p1" }),
        orders: [
          order({
            id: 1,
            txHash: null,
            description: null,
            completedAt: null,
            createdAt: null,
          }),
        ],
      },
    ]);
    const r = parseCsv(file.csv).rows[0];
    expect(cell(r, "txHash")).toBe("");
    expect(cell(r, "description")).toBe("");
    expect(cell(r, "orderDate")).toBe("");
  });

  it("writes a header-only file (never an empty download) for an empty window", () => {
    const file = build([]);
    expect(file.count).toBe(0);
    expect(file.payoutCount).toBe(0);
    expect(parseCsv(file.csv).rows).toEqual([]);
    expect(file.csv.startsWith("﻿")).toBe(true);
  });

  it("neutralises a formula smuggled in through a description", () => {
    const file = build([
      {
        payout: payout({ id: "p1" }),
        orders: [order({ id: 1, description: "=1+1" })],
      },
    ]);
    expect(file.csv).toContain("'=1+1");
  });
});
