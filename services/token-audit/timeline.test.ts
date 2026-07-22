// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  buildBalanceTimeline,
  formatSignedAmount,
  hexToBigInt,
  sortNewestFirst,
  type AuditTransfer,
} from "./timeline";

const ACCOUNT = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0x0000000000000000000000000000000000000000";

function tx(
  overrides: Partial<AuditTransfer> & { blockNum: string; rawValue: string },
): AuditTransfer {
  return {
    uniqueId: `${overrides.hash ?? "0xdead"}:log:0`,
    hash: "0xdead",
    from: OTHER,
    to: ACCOUNT,
    blockTimestamp: null,
    ...overrides,
  };
}

describe("sortNewestFirst", () => {
  it("orders by block number descending", () => {
    const sorted = sortNewestFirst([
      tx({ blockNum: "0x1", rawValue: "0x1", uniqueId: "a:log:0" }),
      tx({ blockNum: "0x3", rawValue: "0x1", uniqueId: "b:log:0" }),
      tx({ blockNum: "0x2", rawValue: "0x1", uniqueId: "c:log:0" }),
    ]);
    expect(sorted.map((t) => t.blockNum)).toEqual(["0x3", "0x2", "0x1"]);
  });

  it("breaks same-block ties by log index descending", () => {
    const sorted = sortNewestFirst([
      tx({ blockNum: "0x5", rawValue: "0x1", uniqueId: "a:log:2" }),
      tx({ blockNum: "0x5", rawValue: "0x1", uniqueId: "b:log:7" }),
    ]);
    expect(sorted.map((t) => t.uniqueId)).toEqual(["b:log:7", "a:log:2"]);
  });
});

describe("buildBalanceTimeline", () => {
  it("reconstructs running balances backwards from the current balance", () => {
    // History (oldest → newest): mint +100, spend −30, receive +5 ⇒ balance 75.
    const transfers = [
      tx({ blockNum: "0x3", rawValue: "0x5", from: OTHER, to: ACCOUNT, uniqueId: "c:log:0" }),
      tx({ blockNum: "0x2", rawValue: "0x1e", from: ACCOUNT, to: OTHER, uniqueId: "b:log:0" }),
      tx({ blockNum: "0x1", rawValue: "0x64", from: ZERO, to: ACCOUNT, uniqueId: "a:log:0" }),
    ];
    const timeline = buildBalanceTimeline({
      account: ACCOUNT,
      currentBalance: BigInt(75),
      transfers,
    });

    expect(timeline.entries.map((e) => e.balanceAfter)).toEqual([BigInt(75), BigInt(70), BigInt(100)]);
    expect(timeline.entries.map((e) => e.delta)).toEqual([BigInt(5), -BigInt(30), BigInt(100)]);
    expect(timeline.totalIn).toBe(BigInt(105));
    expect(timeline.totalOut).toBe(BigInt(30));
    expect(timeline.openingBalance).toBe(BigInt(0)); // fully explained
  });

  it("surfaces an unexplained opening balance when history doesn't add up", () => {
    const timeline = buildBalanceTimeline({
      account: ACCOUNT,
      currentBalance: BigInt(80),
      transfers: [
        tx({ blockNum: "0x1", rawValue: "0x32", from: OTHER, to: ACCOUNT }),
      ],
    });
    expect(timeline.openingBalance).toBe(BigInt(30)); // 80 − (+50)
  });

  it("treats self-transfers as zero delta and matches case-insensitively", () => {
    const timeline = buildBalanceTimeline({
      account: ACCOUNT,
      currentBalance: BigInt(10),
      transfers: [
        tx({
          blockNum: "0x1",
          rawValue: "0x7",
          from: ACCOUNT.toUpperCase().replace("0X", "0x"),
          to: ACCOUNT.toLowerCase(),
        }),
      ],
    });
    expect(timeline.entries[0]!.direction).toBe("self");
    expect(timeline.entries[0]!.delta).toBe(BigInt(0));
    expect(timeline.entries[0]!.balanceAfter).toBe(BigInt(10));
    expect(timeline.openingBalance).toBe(BigInt(10));
  });

  it("identifies counterparties per direction", () => {
    const timeline = buildBalanceTimeline({
      account: ACCOUNT,
      currentBalance: BigInt(0),
      transfers: [
        tx({ blockNum: "0x2", rawValue: "0x1", from: ACCOUNT, to: OTHER, uniqueId: "b:log:0" }),
        tx({ blockNum: "0x1", rawValue: "0x1", from: ZERO, to: ACCOUNT, uniqueId: "a:log:0" }),
      ],
    });
    expect(timeline.entries[0]!.counterparty).toBe(OTHER); // out → recipient
    expect(timeline.entries[1]!.counterparty).toBe(ZERO); // in → sender (mint)
  });
});

describe("hexToBigInt", () => {
  it("parses hex with and without prefix, degrading to 0", () => {
    expect(hexToBigInt("0x64")).toBe(BigInt(100));
    expect(hexToBigInt("64")).toBe(BigInt(100));
    expect(hexToBigInt("")).toBe(BigInt(0));
    expect(hexToBigInt("0xzz")).toBe(BigInt(0));
    expect(hexToBigInt(null)).toBe(BigInt(0));
  });
});

describe("formatSignedAmount", () => {
  const identity = (raw: string) => raw;
  it("prefixes sign and formats the absolute value", () => {
    expect(formatSignedAmount(BigInt(5), identity)).toBe("+5");
    expect(formatSignedAmount(-BigInt(5), identity)).toBe("−5");
    expect(formatSignedAmount(BigInt(0), identity)).toBe("0");
  });
});
