// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The MCP payout tools around the fee sweep answers of citizenpay/api#277:
// "still settling" is a non-failing "retry later", "nothing to transfer" is
// done. The operations engine and the tenant gate are stubbed; the tools are
// captured from a fake McpServer and called directly.
vi.mock("server-only", () => ({}));
const { ops } = vi.hoisted(() => ({
  ops: { feeTransfer: vi.fn(), burnPayout: vi.fn() },
}));
vi.mock("@/services/payout/operations", () => ops);
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("./authz", () => ({
  McpToolError: class McpToolError extends Error {},
  requireFundForTool: async () => ({
    fund: { id: "fund-1", name: "Acme", citizenPayApiKeyId: "0xkey", citizenPayApiKeyEnc: "enc" },
  }),
}));

import { registerPayoutTools } from "./payout-tools";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;
const tools = new Map<string, { description: string; handler: Handler }>();
registerPayoutTools(
  {
    registerTool: (name: string, def: { description: string }, handler: Handler) =>
      tools.set(name, { description: def.description, handler }),
  } as never,
  { userId: "user-1", fundDomain: "acme.lacaisse.eu" },
);
const call = async (name: string, args: Record<string, unknown>) => {
  const res = await tools.get(name)!.handler(args);
  return { isError: res.isError ?? false, body: res.isError ? res.content[0].text : JSON.parse(res.content[0].text) };
};

beforeEach(() => vi.clearAllMocks());

describe("sweep_payout_fees", () => {
  it("answers 'settling' without failing when fees are still settling", async () => {
    ops.feeTransfer.mockResolvedValue({ settling: true, message: "Fees still settling" });
    const res = await call("sweep_payout_fees", { payoutId: "p1" });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ payoutId: "p1", status: "settling", retryAfterSeconds: 30 });
  });

  it("answers 'nothing_to_transfer' (done) when every fee was collected at payment", async () => {
    ops.feeTransfer.mockResolvedValue({
      ok: true,
      feeTransferTxHash: null,
      feeAmount: null,
      alreadyTransferred: false,
      nothingToTransfer: true,
    });
    const res = await call("sweep_payout_fees", { payoutId: "p1" });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ status: "nothing_to_transfer" });
  });

  it("still reports a real sweep, and fails on a real error", async () => {
    ops.feeTransfer.mockResolvedValue({
      ok: true,
      feeTransferTxHash: "0xfee",
      feeAmount: "1.25",
      alreadyTransferred: false,
    });
    expect((await call("sweep_payout_fees", { payoutId: "p1" })).body).toMatchObject({
      status: "swept",
      feeTransferTxHash: "0xfee",
    });
    ops.feeTransfer.mockResolvedValue({ error: "insufficient balance" });
    expect(await call("sweep_payout_fees", { payoutId: "p1" })).toEqual({
      isError: true,
      body: "insufficient balance",
    });
  });

  it("describes both non-failing answers", () => {
    const d = tools.get("sweep_payout_fees")!.description;
    expect(d).toContain("settling");
    expect(d).toContain("nothing_to_transfer");
  });
});

describe("burn_payout", () => {
  it("passes on nothingToSweep and feeSettling with their hints", async () => {
    ops.burnPayout.mockResolvedValue({
      ok: true,
      txHash: "0xburn",
      feeTransferTxHash: null,
      feeTransferPending: false,
      feeTransferError: null,
      nothingToSweep: true,
    });
    let res = await call("burn_payout", { payoutId: "p1", confirm: true });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ nothingToSweep: true, feeSettling: false });
    expect(res.body.hint).toMatch(/Nothing to transfer/);

    ops.burnPayout.mockResolvedValue({
      ok: true,
      txHash: "0xburn",
      feeTransferPending: true,
      feeTransferError: "Fees still settling",
      feeSettling: true,
    });
    res = await call("burn_payout", { payoutId: "p1", confirm: true });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ feeSettling: true, feeTransferPending: true });
    expect(res.body.hint).toMatch(/sweep_payout_fees again/);
  });
});
