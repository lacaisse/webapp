// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";

import {
  buildBackingReport,
  decodeTransferLogs,
  evaluateBalance,
  evaluateSharedSettlements,
  sharedSettlementGroups,
  TRANSFER_TOPIC,
  type BackingOrder,
  type TokenTransfer,
} from "./backing";

const TOKEN = "0x3333333333333333333333333333333333333333";
const PLACE = "0xAbCd000000000000000000000000000000000001";
const LEGACY = "0x9999999999999999999999999999999999999999";
const MINTER = "0x0000000000000000000000000000000000000000";
const H1 = `0x${"a1".repeat(32)}`;
const H2 = `0x${"b2".repeat(32)}`;
const H3 = `0x${"c3".repeat(32)}`;
const OPTS = { token: TOKEN, placeAccount: PLACE, decimals: 6 };

const u = (d: string) => parseUnits(d, 6);
const order = (o: Partial<BackingOrder> & { id: number }): BackingOrder => ({
  status: "paid",
  txHash: null,
  total: "10.00",
  fees: "0.00",
  ...o,
});
const mint = (to: string, amount: string, token = TOKEN): TokenTransfer => ({
  token,
  from: MINTER,
  to,
  value: u(amount),
});

describe("sharedSettlementGroups", () => {
  it("groups non-leg orders by hash, case-insensitively, summing total − fees", () => {
    const groups = sharedSettlementGroups([
      order({ id: 1, txHash: H1, total: "12.00", fees: "0.50" }),
      order({ id: 2, txHash: H1.toUpperCase().replace("0X", "0x"), total: "12.00", fees: "0.50" }),
      order({ id: 3, txHash: H2 }),
    ]);
    expect(groups).toEqual([{ txHash: H1, orderIds: [1, 2], required: "23.00" }]);
  });

  it("never groups refund / correction / topup legs or hashless orders", () => {
    const groups = sharedSettlementGroups([
      order({ id: 1, txHash: H1 }),
      order({ id: 2, status: "refund", txHash: H1 }),
      order({ id: 3, status: "correction", txHash: H1 }),
      order({ id: 4, status: "topup", txHash: H1 }),
      order({ id: 5 }),
      order({ id: 6 }),
      order({ id: 7, status: "refund" }),
      order({ id: 8, status: "refund" }),
    ]);
    expect(groups).toEqual([]);
  });
});

describe("evaluateSharedSettlements", () => {
  it("La Regina: 3 extra copies of one order under a single transfer → uncovered", () => {
    const groups = sharedSettlementGroups(
      [1, 2, 3, 4].map((id) => order({ id, txHash: H1, total: "20.00" })),
    );
    const [check] = evaluateSharedSettlements(
      groups,
      new Map([[H1, [mint(PLACE, "20.00")]]]),
      OPTS,
    );
    expect(check).toEqual({
      txHash: H1,
      orderIds: [1, 2, 3, 4],
      required: "80.00",
      found: "20",
      verdict: "uncovered",
    });
  });

  it("a hash whose only transfer went to another account → uncovered, found 0", () => {
    const groups = sharedSettlementGroups([
      order({ id: 1, txHash: H2 }),
      order({ id: 2, txHash: H2 }),
    ]);
    const [check] = evaluateSharedSettlements(
      groups,
      new Map([[H2, [mint(LEGACY, "20.00")]]]),
      OPTS,
    );
    expect(check).toMatchObject({ verdict: "uncovered", found: "0" });
  });

  it("ignores transfers of another token", () => {
    const groups = sharedSettlementGroups([order({ id: 1, txHash: H1 }), order({ id: 2, txHash: H1 })]);
    const [check] = evaluateSharedSettlements(
      groups,
      new Map([[H1, [mint(PLACE, "20.00", "0x4444444444444444444444444444444444444444")]]]),
      OPTS,
    );
    expect(check.verdict).toBe("uncovered");
  });

  it("a genuine batch (2 orders, 2 transfers that add up) → covered, not blocking", () => {
    const groups = sharedSettlementGroups([
      order({ id: 1, txHash: H3, total: "10.00" }),
      order({ id: 2, txHash: H3, total: "5.50" }),
    ]);
    const settlements = evaluateSharedSettlements(
      groups,
      // Matched on the lower-cased hash, place address in any case.
      new Map([[H3, [mint(PLACE.toLowerCase(), "10.00"), mint(PLACE, "5.50")]]]),
      OPTS,
    );
    expect(settlements[0]).toMatchObject({ verdict: "covered", found: "15.5", required: "15.50" });
    const report = buildBackingReport({
      settlements,
      balance: { verdict: "ok", balance: "100", required: "15.50" },
      ordersRead: "ok",
    });
    expect(report.blocking).toBe(false);
    expect(report.duplicates).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.settlements).toHaveLength(1);
  });

  it("unverified when the logs could not be read, or the place / token is unknown", () => {
    const groups = sharedSettlementGroups([order({ id: 1, txHash: H1 }), order({ id: 2, txHash: H1 })]);
    expect(evaluateSharedSettlements(groups, new Map([[H1, null]]), OPTS)[0].verdict).toBe(
      "unverified",
    );
    expect(evaluateSharedSettlements(groups, new Map(), OPTS)[0].verdict).toBe("unverified");
    expect(
      evaluateSharedSettlements(groups, new Map([[H1, [mint(PLACE, "20")]]]), {
        ...OPTS,
        placeAccount: null,
      })[0],
    ).toMatchObject({ verdict: "unverified", found: null });
  });
});

describe("decodeTransferLogs", () => {
  const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
  it("decodes Transfer logs and skips anything else", () => {
    const out = decodeTransferLogs([
      {
        address: TOKEN,
        topics: [TRANSFER_TOPIC, topic(MINTER), topic(PLACE)],
        data: `0x${u("1.5").toString(16).padStart(64, "0")}`,
      },
      { address: TOKEN, topics: ["0xdead"], data: "0x01" },
      { address: TOKEN, topics: [TRANSFER_TOPIC, topic(MINTER), topic(PLACE)], data: "zz" },
    ]);
    expect(out).toEqual([
      { token: TOKEN, from: MINTER, to: PLACE.toLowerCase(), value: u("1.5") },
    ]);
  });
});

describe("evaluateBalance", () => {
  const payout = { totalAmount: "52.00", totalFees: "2.00", burnTxHashes: [] };

  it("short when the wallet holds less than net + retained cut", () => {
    expect(evaluateBalance({ balanceUnits: u("49"), payout, decimals: 6 })).toEqual({
      verdict: "short",
      balance: "49",
      required: "50.00",
      shortfall: "1",
    });
  });

  it("ok on the exact amount", () => {
    expect(evaluateBalance({ balanceUnits: u("50"), payout, decimals: 6 })).toEqual({
      verdict: "ok",
      balance: "50",
      required: "50.00",
    });
  });

  it("unverified when the balance could not be read", () => {
    expect(evaluateBalance({ balanceUnits: null, payout, decimals: 6 })).toEqual({
      verdict: "unverified",
      required: "50.00",
    });
  });

  it("not applicable once a burn is recorded, or the payout is burnt / complete", () => {
    const na = { verdict: "notApplicable", reason: "burnRecorded" };
    expect(
      evaluateBalance({
        balanceUnits: BigInt(0),
        payout: { ...payout, burnTxHashes: [H1] },
        decimals: 6,
      }),
    ).toEqual(na);
    expect(evaluateBalance({ balanceUnits: BigInt(0), payout, status: "burnt", decimals: 6 })).toEqual(na);
    expect(evaluateBalance({ balanceUnits: null, payout, status: "complete", decimals: 6 })).toEqual(na);
  });
});

describe("buildBackingReport", () => {
  const ok = { verdict: "ok" as const, balance: "100", required: "50.00" };
  const uncovered = {
    txHash: H1,
    orderIds: [1, 2, 3, 4],
    required: "80.00",
    found: "20",
    verdict: "uncovered" as const,
  };

  it("blocks on an uncovered group and says which orders, hash and amounts", () => {
    const r = buildBackingReport({ settlements: [uncovered], balance: ok, ordersRead: "ok", symbol: "EURb" });
    expect(r.blocking).toBe(true);
    expect(r.duplicates).toEqual([uncovered]);
    expect(r.warnings).toEqual([
      `Orders 1, 2, 3, 4 share settlement tx ${H1}: together they need 80.00 EURb credited to the place, but that tx moved only 20 EURb to the place account. Paying all of them overpays the merchant by up to 60.00 EURb (likely duplicate order rows).`,
    ]);
  });

  it("blocks on an unverified group", () => {
    const r = buildBackingReport({
      settlements: [{ ...uncovered, found: null, verdict: "unverified" }],
      balance: ok,
      ordersRead: "ok",
    });
    expect(r.blocking).toBe(true);
    expect(r.warnings[0]).toContain("could not be read");
  });

  it("blocks on a short or unverified balance, not on a not-applicable one", () => {
    const short = buildBackingReport({
      settlements: [],
      balance: { verdict: "short", balance: "113.64", required: "791.43", shortfall: "677.79" },
      ordersRead: "ok",
      symbol: "EURb",
      placeAccount: PLACE,
    });
    expect(short.blocking).toBe(true);
    expect(short.warnings).toEqual([
      `The place wallet ${PLACE} holds 113.64 EURb, but settling this payout removes 791.43 EURb (net + retained cut): short by 677.79 EURb.`,
    ]);
    expect(
      buildBackingReport({
        settlements: [],
        balance: { verdict: "unverified", required: "50.00" },
        ordersRead: "ok",
      }).blocking,
    ).toBe(true);
    const na = buildBackingReport({
      settlements: [],
      balance: { verdict: "notApplicable", reason: "burnRecorded" },
      ordersRead: "ok",
    });
    expect(na).toMatchObject({ blocking: false, warnings: [] });
  });

  it("blocks when the orders were truncated or unreadable", () => {
    for (const ordersRead of ["truncated", "failed"] as const) {
      const r = buildBackingReport({ settlements: [], balance: ok, ordersRead });
      expect(r.blocking).toBe(true);
      expect(r.warnings).toHaveLength(1);
    }
  });
});
