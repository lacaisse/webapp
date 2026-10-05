// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The check that gates "Record burn": the chain reads are faked, the log
// matching is real.
vi.mock("server-only", () => ({}));
const chain = vi.hoisted(() => ({
  getTxReceiptWithLogs: vi.fn(),
  getUserOpTx: vi.fn(),
}));
vi.mock("@/services/token/userop", () => ({
  ...chain,
  TRANSFER_TOPIC:
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
}));

import { verifyPayoutBurn } from "./burn-verify";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN = "0x3333333333333333333333333333333333333333";
const PLACE = "0xAbCd000000000000000000000000000000000001";
const OTHER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"ab".repeat(32)}`;
const USEROP = `0x${"cd".repeat(32)}`;
const NET = BigInt(48_750_000); // 48.75 at 6 decimals

const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const ZERO = `0x${"0".repeat(64)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

function transferLog(over: Partial<{ address: string; from: string; to: string; amount: bigint }> = {}) {
  return {
    address: over.address ?? TOKEN.toUpperCase().replace("0X", "0x"),
    topics: [TRANSFER, topic(over.from ?? PLACE), over.to ? topic(over.to) : ZERO],
    data: word(over.amount ?? NET),
  };
}

function receipt(logs: unknown[], status: "success" | "reverted" = "success") {
  return { transactionHash: TX, status, logs };
}

const args = { chainId: 100, hash: TX, token: TOKEN, from: PLACE, amount: NET, decimals: 6 };

beforeEach(() => {
  vi.clearAllMocks();
  chain.getUserOpTx.mockResolvedValue({ status: "pending", txHash: null });
});

describe("verifyPayoutBurn", () => {
  it("accepts a successful burn of exactly the net from the place", async () => {
    chain.getTxReceiptWithLogs.mockResolvedValueOnce(receipt([transferLog()]));
    expect(await verifyPayoutBurn(args)).toEqual({ ok: true, txHash: TX });
    expect(chain.getUserOpTx).not.toHaveBeenCalled();
  });

  it("resolves a userOp hash to its settlement tx", async () => {
    chain.getTxReceiptWithLogs
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(receipt([transferLog()]));
    chain.getUserOpTx.mockResolvedValueOnce({ status: "success", txHash: TX });
    expect(await verifyPayoutBurn({ ...args, hash: USEROP })).toEqual({ ok: true, txHash: TX });
    expect(chain.getTxReceiptWithLogs).toHaveBeenLastCalledWith({ chainId: 100, txHash: TX });
  });

  it("refuses a hash the chain doesn't know", async () => {
    chain.getTxReceiptWithLogs.mockResolvedValueOnce(null);
    expect(await verifyPayoutBurn(args)).toEqual({ reason: "notFound" });
  });

  it("refuses a reverted tx", async () => {
    chain.getTxReceiptWithLogs.mockResolvedValueOnce(receipt([], "reverted"));
    expect(await verifyPayoutBurn(args)).toEqual({ reason: "notSuccessful" });
  });

  it("refuses a reverted userOp", async () => {
    chain.getTxReceiptWithLogs.mockResolvedValueOnce(null);
    chain.getUserOpTx.mockResolvedValueOnce({ status: "reverted", txHash: TX });
    expect(await verifyPayoutBurn({ ...args, hash: USEROP })).toEqual({
      reason: "notSuccessful",
    });
  });

  it.each([
    ["another token", { address: OTHER }],
    ["another account", { from: OTHER }],
    ["a transfer, not a burn", { to: OTHER }],
  ])("refuses %s", async (_label, over) => {
    chain.getTxReceiptWithLogs.mockResolvedValueOnce(receipt([transferLog(over)]));
    expect(await verifyPayoutBurn(args)).toEqual({ reason: "notBurn" });
  });

  it("refuses a burn of the wrong amount, naming both", async () => {
    chain.getTxReceiptWithLogs.mockResolvedValueOnce(
      receipt([transferLog({ amount: BigInt(40_000_000) })]),
    );
    expect(await verifyPayoutBurn(args)).toEqual({
      reason: "wrongAmount",
      found: "40",
      expected: "48.75",
    });
  });

  it("propagates a chain read failure (never reads it as not found)", async () => {
    chain.getTxReceiptWithLogs.mockRejectedValueOnce(new Error("bundler down"));
    await expect(verifyPayoutBurn(args)).rejects.toThrow("bundler down");
  });
});
