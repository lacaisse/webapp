// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { Payout, PayoutStatus } from "@/services/citizenpay/types";
import { parseCsv } from "@/services/csv/parse";

import {
  buildPayoutExportCsv,
  payoutExportFilename,
  payoutPeriodEndDay,
  resolvePayoutExportPreset,
  resolvePayoutExportRange,
  selectPayoutsForExport,
  summarizePayoutsByMerchant,
  PAYOUT_EXPORT_COLUMNS,
} from "./export";

// A payout with the fields the export reads. Settlement bounds are UTC
// midnights and `endDate` is exclusive, exactly as CitizenPay stores them.
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

// Identity translator: keys come back as themselves, which keeps the assertions
// about structure rather than about copy.
const t = (key: string) => key;

describe("resolvePayoutExportPreset", () => {
  const now = new Date("2026-08-17T13:45:00Z");

  it("resolves calendar months inclusively", () => {
    expect(resolvePayoutExportPreset("thisMonth", now)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(resolvePayoutExportPreset("lastMonth", now)).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("resolves quarters", () => {
    expect(resolvePayoutExportPreset("thisQuarter", now)).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
    expect(resolvePayoutExportPreset("lastQuarter", now)).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
  });

  it("resolves years, crossing the boundary backwards", () => {
    expect(resolvePayoutExportPreset("thisYear", now)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(resolvePayoutExportPreset("lastYear", now)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("rolls a Q1 'last quarter' into the previous year", () => {
    const january = new Date("2026-01-09T00:00:00Z");
    expect(resolvePayoutExportPreset("lastQuarter", january)).toEqual({
      from: "2025-10-01",
      to: "2025-12-31",
    });
  });
});

describe("resolvePayoutExportRange", () => {
  const now = new Date("2026-08-17T13:45:00Z");

  it("keeps a valid pair from the URL, single day included", () => {
    expect(resolvePayoutExportRange("2026-03-01", "2026-03-01", now)).toEqual({
      from: "2026-03-01",
      to: "2026-03-01",
    });
  });

  it("falls back to the default preset on missing, malformed or reversed input", () => {
    const fallback = { from: "2026-07-01", to: "2026-07-31" };
    expect(resolvePayoutExportRange(undefined, undefined, now)).toEqual(fallback);
    expect(resolvePayoutExportRange("01/03/2026", "2026-03-31", now)).toEqual(
      fallback,
    );
    expect(resolvePayoutExportRange("2026-03-31", "2026-03-01", now)).toEqual(
      fallback,
    );
  });
});

describe("payoutPeriodEndDay", () => {
  it("reports the inclusive last day covered, not the exclusive bound", () => {
    expect(payoutPeriodEndDay(payout({ id: "p1" }))).toBe("2026-07-31");
  });
});

describe("selectPayoutsForExport", () => {
  const july = payout({ id: "july" });
  const august = payout({
    id: "august",
    startDate: "2026-08-01T00:00:00Z",
    endDate: "2026-09-01T00:00:00Z",
  });
  const june = payout({
    id: "june",
    startDate: "2026-06-01T00:00:00Z",
    endDate: "2026-07-01T00:00:00Z",
  });

  it("matches on the settlement period start, inclusive on both ends", () => {
    const picked = selectPayoutsForExport([june, july, august], {
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(picked.map((p) => p.id)).toEqual(["july"]);
  });

  it("partitions contiguous months exactly once each", () => {
    const all = [june, july, august];
    const months = [
      { from: "2026-06-01", to: "2026-06-30" },
      { from: "2026-07-01", to: "2026-07-31" },
      { from: "2026-08-01", to: "2026-08-31" },
    ];
    const picked = months.flatMap((m) =>
      selectPayoutsForExport(all, m).map((p) => p.id),
    );
    expect(picked).toEqual(["june", "july", "august"]);
  });

  it("sorts by period, then merchant, then id", () => {
    const zoe = payout({ id: "b", placeId: "place-2", placeName: "Zoé" });
    const anna = payout({ id: "a", placeId: "place-3", placeName: "Anna" });
    const picked = selectPayoutsForExport([zoe, anna, august, july], {
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(picked.map((p) => p.id)).toEqual(["a", "july", "b", "august"]);
  });
});

describe("summarizePayoutsByMerchant", () => {
  it("rolls amounts up per place in cents, heaviest net first", () => {
    const rows = summarizePayoutsByMerchant([
      payout({ id: "a", net: "0.10", totalAmount: "0.10" }),
      payout({ id: "b", net: "0.20", totalAmount: "0.20" }),
      payout({
        id: "c",
        placeId: "place-2",
        placeName: "Épicerie",
        net: "1.00",
        totalAmount: "1.00",
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ merchant: "Épicerie", payoutCount: 1, net: "1.00" });
    // 0.10 + 0.20 summed as floats would be 0.30000000000000004.
    expect(rows[1]).toMatchObject({ merchant: "Chez Léa", payoutCount: 2, net: "0.30" });
  });
});

describe("payoutExportFilename", () => {
  it("uses the first label of the fund domain, asciified", () => {
    expect(
      payoutExportFilename("acme.lacaisse.eu", {
        from: "2026-07-01",
        to: "2026-07-31",
      }),
    ).toBe("payouts_acme_2026-07-01_2026-07-31.csv");
    expect(
      payoutExportFilename("funds.acme.com", {
        from: "2026-07-01",
        to: "2026-07-31",
      }),
    ).toBe("payouts_funds_2026-07-01_2026-07-31.csv");
  });

  it("strips accents and punctuation out of the label", () => {
    expect(
      payoutExportFilename("caisse-du-thé!.lacaisse.eu", {
        from: "2026-01-01",
        to: "2026-01-31",
      }),
    ).toBe("payouts_caisse-du-the_2026-01-01_2026-01-31.csv");
  });

  it("falls back rather than emitting an empty name segment", () => {
    expect(
      payoutExportFilename("", { from: "2026-01-01", to: "2026-01-31" }),
    ).toBe("payouts_fund_2026-01-01_2026-01-31.csv");
  });
});

describe("buildPayoutExportCsv", () => {
  const range = { from: "2026-07-01", to: "2026-07-31" };

  it("emits the localized header plus one row per payout in range", () => {
    const outside = payout({
      id: "aug",
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-09-01T00:00:00Z",
    });
    const file = buildPayoutExportCsv({
      payouts: [payout({ id: "p1" }), outside],
      range,
      fundDomain: "acme.lacaisse.eu",
      locale: "fr",
      t,
    });

    expect(file.count).toBe(1);
    expect(file.filename).toBe("payouts_acme_2026-07-01_2026-07-31.csv");

    const parsed = parseCsv(file.csv);
    expect(parsed.headers).toEqual(
      PAYOUT_EXPORT_COLUMNS.map((c) => `fund.payments.export.columns.${c}`),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toEqual([
      "2026-07-01",
      "2026-07-31",
      "Chez Léa",
      "Boulangerie SA",
      "510,00",
      "10,00",
      "12,50",
      "7,50",
      "",
      "480,00",
      "fund.payments.settlement.statuses.complete",
      "2026-08-03 09:12",
      "p1",
    ]);
  });

  it("keeps the fee split as three distinct columns that reconcile to net", () => {
    const file = buildPayoutExportCsv({
      payouts: [payout({ id: "p1" })],
      range,
      fundDomain: "acme.lacaisse.eu",
      locale: "en",
      t,
    });
    const cells = parseCsv(file.csv).rows[0];
    const at = (column: (typeof PAYOUT_EXPORT_COLUMNS)[number]) =>
      Number(cells[PAYOUT_EXPORT_COLUMNS.indexOf(column)]);
    expect(
      at("gross") - at("processorFees") - at("platformFee") - at("manualDeduction"),
    ).toBeCloseTo(at("net"), 2);
  });

  it("includes every lifecycle status, distinguished by the status column", () => {
    const statuses: PayoutStatus[] = [
      "pending",
      "payment-pending",
      "burnt",
      "complete",
    ];
    const file = buildPayoutExportCsv({
      payouts: statuses.map((status, i) =>
        payout({ id: `p${i}`, status, placeId: `place-${i}`, placeName: `M${i}` }),
      ),
      range,
      fundDomain: "acme.lacaisse.eu",
      locale: "fr",
      t,
    });
    expect(file.count).toBe(4);
    const statusColumn = PAYOUT_EXPORT_COLUMNS.indexOf("status");
    expect(parseCsv(file.csv).rows.map((r) => r[statusColumn])).toEqual(
      statuses.map((s) => `fund.payments.settlement.statuses.${s}`),
    );
  });

  it("writes a header-only file (never an empty download) for an empty window", () => {
    const file = buildPayoutExportCsv({
      payouts: [],
      range,
      fundDomain: "acme.lacaisse.eu",
      locale: "fr",
      t,
    });
    expect(file.count).toBe(0);
    expect(parseCsv(file.csv).rows).toEqual([]);
    expect(file.csv.startsWith("﻿")).toBe(true);
  });
});
