// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitizenPayApiError } from "@/services/citizenpay/api";
import type { Payout } from "@/services/citizenpay/types";

// Harness: operations.ts is the money engine, so its burn path is tested with
// every boundary swapped out — the CitizenPay client (a fake implementing just
// the calls the burn makes), the on-chain `burnDirect`, and the annotation /
// cache side effects. Nothing here reaches a database, the network or a chain.
// `server-only` can't be resolved under vitest; a virtual mock stands in.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));

const cp = vi.hoisted(() => ({
  getPayoutStatus: vi.fn(),
  claimPayoutBurn: vi.fn(),
  releasePayoutBurn: vi.fn(),
  getPayout: vi.fn(),
  getPayoutOrders: vi.fn(),
  burnPayout: vi.fn(),
}));
vi.mock("@/services/citizenpay/client", () => ({
  getCitizenPayClient: () => cp,
}));

const burnDirect = vi.hoisted(() => vi.fn());
vi.mock("@/services/token-operations/direct", () => ({
  burnDirect,
  mintDirect: vi.fn(),
}));

const resolveOrEnqueueAnnotation = vi.hoisted(() => vi.fn());
vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation,
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({
  ANNOTATION_TRIGGERS: {
    payoutBurn: "PAYOUT_BURN",
    payoutFee: "PAYOUT_FEE",
    orderSettlementMint: "ORDER_SETTLEMENT_MINT",
    orderSettlementBurn: "ORDER_SETTLEMENT_BURN",
  },
}));
vi.mock("@/services/alchemy/transfers", () => ({}));
const verifyPayoutBurn = vi.hoisted(() => vi.fn());
vi.mock("./burn-verify", () => ({ verifyPayoutBurn }));
vi.mock("./receipts", () => ({ resolveOrderReceipts: vi.fn() }));

import {
  burnPayout,
  recordPayoutBurn,
  releasePayoutBurnClaim,
  type PayoutContext,
} from "./operations";

const PAYOUT = "payout-1";
const CLAIM = { claimId: "claim-1", claimedAt: "2026-10-05T09:30:00Z" };
const PLACE = "0x1111111111111111111111111111111111111111";
const MINTER = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;

// Translator that shows the key plus any interpolated values, so assertions
// can check which message was chosen and what it was filled with.
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

const TOKEN = "0x3333333333333333333333333333333333333333";
const ctx = {
  fund: {
    id: "fund-1",
    tokenChainId: 100,
    tokenMinterSmartAccountAddress: MINTER,
    tokenAddress: TOKEN,
    tokenDecimals: 6,
  },
  userId: "user-1",
  t,
} as unknown as PayoutContext;

const E = "fund.payments.settlement.errors";

function report(over: Record<string, unknown> = {}) {
  return {
    feeAmount: "1.25",
    feeTransferTxHash: "0xfee",
    feeTransferPending: false,
    feeTransferError: null,
    duplicateBurn: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cp.getPayoutStatus.mockResolvedValue({ status: "pending", burnClaim: null });
  cp.claimPayoutBurn.mockResolvedValue(CLAIM);
  cp.releasePayoutBurn.mockResolvedValue(undefined);
  cp.getPayout.mockResolvedValue({ id: PAYOUT, net: "48.75" } as Payout);
  cp.getPayoutOrders.mockResolvedValue({ placeAccountAddress: PLACE });
  cp.burnPayout.mockResolvedValue(report());
  burnDirect.mockResolvedValue({ ok: true, txHash: TX, userOpHash: "0xuserop" });
});

describe("burnPayout — claim before burning", () => {
  it("claims, burns, and reports the hash with the claim id", async () => {
    const res = await burnPayout(ctx, PAYOUT);
    expect(res).toMatchObject({ ok: true, txHash: TX, feeTransferTxHash: "0xfee" });
    expect(cp.claimPayoutBurn).toHaveBeenCalledWith(PAYOUT);
    // The claim is taken BEFORE anything touches the chain.
    expect(cp.claimPayoutBurn.mock.invocationCallOrder[0]).toBeLessThan(
      burnDirect.mock.invocationCallOrder[0],
    );
    expect(burnDirect).toHaveBeenCalledWith(
      expect.anything(),
      { from: PLACE, amount: "48.75" },
      { trigger: "PAYOUT_BURN" },
    );
    expect(cp.burnPayout).toHaveBeenCalledWith(PAYOUT, TX, MINTER, CLAIM.claimId);
    expect(cp.releasePayoutBurn).not.toHaveBeenCalled();
    expect(resolveOrEnqueueAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ userOpHash: "0xfee", kind: "PAYOUT_FEE" }),
    );
  });

  it("burns nothing when the payout isn't pending", async () => {
    cp.getPayoutStatus.mockResolvedValue({ status: "burnt", burnClaim: null });
    expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.notBurnable` });
    expect(cp.claimPayoutBurn).not.toHaveBeenCalled();
    expect(burnDirect).not.toHaveBeenCalled();
  });

  it.each(["payout is already burnt", "payout is already complete", "payout is not pending"])(
    "maps claim 409 %j to not-burnable and burns nothing",
    async (message) => {
      cp.claimPayoutBurn.mockRejectedValueOnce(
        new CitizenPayApiError(message, 409, { error: message }),
      );
      expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.notBurnable` });
      expect(burnDirect).not.toHaveBeenCalled();
      expect(cp.burnPayout).not.toHaveBeenCalled();
    },
  );

  it("says another attempt is in progress (with its start time) on a held claim", async () => {
    cp.claimPayoutBurn.mockRejectedValueOnce(
      new CitizenPayApiError("burn already in progress", 409, {
        error: "burn already in progress",
        claimedAt: "2026-10-05T09:30:12Z",
        source: "external",
      }),
    );
    const res = await burnPayout(ctx, PAYOUT);
    expect(res).toEqual({
      error: `${E}.burnInProgress ${JSON.stringify({ claimedAt: "2026-10-05 09:30 UTC" })}`,
    });
    expect(burnDirect).not.toHaveBeenCalled();
    expect(cp.releasePayoutBurn).not.toHaveBeenCalled();
  });

  it("says Citizen Pay itself is burning when the held claim is CP's own", async () => {
    cp.claimPayoutBurn.mockRejectedValueOnce(
      new CitizenPayApiError("burn already in progress", 409, {
        error: "burn already in progress",
        claimedAt: "2026-10-05T09:30:12Z",
        source: "api",
      }),
    );
    expect(await burnPayout(ctx, PAYOUT)).toEqual({
      error: `${E}.burnInProgressByCitizenPay`,
    });
    expect(burnDirect).not.toHaveBeenCalled();
  });

  // Fail closed: no claim, no burn — whatever the reason (including an api
  // that predates the claim route and answers 404).
  it.each([
    ["a network error", new TypeError("fetch failed")],
    ["a 5xx", new CitizenPayApiError("internal error", 500, null)],
    ["a 404 from an older api", new CitizenPayApiError("not found", 404, null)],
    ["an unknown 409", new CitizenPayApiError("something else", 409, null)],
  ])("burns nothing when the claim fails with %s", async (_label, error) => {
    cp.claimPayoutBurn.mockRejectedValueOnce(error);
    expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.burnClaimFailed` });
    expect(burnDirect).not.toHaveBeenCalled();
    expect(cp.burnPayout).not.toHaveBeenCalled();
  });

  it("releases the claim when the payout can't be read", async () => {
    cp.getPayout.mockRejectedValueOnce(new Error("404"));
    expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.payoutNotFound` });
    expect(cp.releasePayoutBurn).toHaveBeenCalledWith(PAYOUT, { claimId: CLAIM.claimId });
    expect(burnDirect).not.toHaveBeenCalled();
  });

  it("releases the claim when the place has no account", async () => {
    cp.getPayoutOrders.mockResolvedValueOnce({ placeAccountAddress: null });
    expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.noPlaceAccount` });
    expect(cp.releasePayoutBurn).toHaveBeenCalledWith(PAYOUT, { claimId: CLAIM.claimId });
  });

  it("releases the claim (by id) when the orders read throws", async () => {
    cp.getPayoutOrders.mockRejectedValueOnce(new Error("timeout"));
    expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.burnFailed` });
    expect(cp.releasePayoutBurn).toHaveBeenCalledWith(PAYOUT, { claimId: CLAIM.claimId });
    expect(burnDirect).not.toHaveBeenCalled();
  });

  it("still returns the read error when the release itself fails", async () => {
    cp.getPayoutOrders.mockRejectedValueOnce(new Error("timeout"));
    cp.releasePayoutBurn.mockRejectedValueOnce(new Error("down"));
    expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.burnFailed` });
    expect(burnDirect).not.toHaveBeenCalled();
  });

  it("releases the claim when the burn failed before it was sent", async () => {
    burnDirect.mockResolvedValueOnce({
      error: "tokenOps.errors.submitFailed",
      broadcast: false,
    });
    expect(await burnPayout(ctx, PAYOUT)).toEqual({
      error: "tokenOps.errors.submitFailed",
    });
    expect(cp.releasePayoutBurn).toHaveBeenCalledWith(PAYOUT, { claimId: CLAIM.claimId });
    expect(cp.burnPayout).not.toHaveBeenCalled();
  });

  it("keeps the claim when the burn may have been sent", async () => {
    burnDirect.mockResolvedValueOnce({
      error: "tokenOps.errors.submitFailed",
      broadcast: true,
    });
    expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.burnMayHaveBeenSent` });
    expect(cp.releasePayoutBurn).not.toHaveBeenCalled();
    expect(cp.burnPayout).not.toHaveBeenCalled();
  });

  it("names the attempted userOp hash when the burn may have been sent", async () => {
    const userOp = `0x${"cd".repeat(32)}`;
    burnDirect.mockResolvedValueOnce({
      error: "tokenOps.errors.submitFailed",
      broadcast: true,
      userOpHash: userOp,
    });
    expect(await burnPayout(ctx, PAYOUT)).toEqual({
      error: `${E}.burnMayHaveBeenSent (userOp ${userOp})`,
    });
    expect(cp.releasePayoutBurn).not.toHaveBeenCalled();
  });

  // The burn confirmed and only our bookkeeping failed: the hash is known, so
  // it's reported right away instead of left for a human.
  it("reports a confirmed burn whose bookkeeping failed, as a success with a warning", async () => {
    burnDirect.mockResolvedValueOnce({
      error: "tokenOps.errors.submitFailed",
      broadcast: true,
      txHash: TX,
      userOpHash: "0xuserop",
    });
    const res = await burnPayout(ctx, PAYOUT);
    expect(res).toMatchObject({
      ok: true,
      txHash: TX,
      warning: `${E}.burnBookkeepingFailed`,
    });
    expect(cp.burnPayout).toHaveBeenCalledWith(PAYOUT, TX, MINTER, CLAIM.claimId);
    expect(cp.releasePayoutBurn).not.toHaveBeenCalled();
  });

  it("keeps the claim when reporting that confirmed burn fails", async () => {
    burnDirect.mockResolvedValueOnce({
      error: "tokenOps.errors.submitFailed",
      broadcast: true,
      txHash: TX,
    });
    cp.burnPayout.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await burnPayout(ctx, PAYOUT)).toEqual({
      error: `${E}.reportFailed (tx ${TX})`,
    });
    expect(cp.releasePayoutBurn).not.toHaveBeenCalled();
  });

  it("keeps the claim when burnDirect throws (unclassified)", async () => {
    burnDirect.mockRejectedValueOnce(new Error("db down"));
    expect(await burnPayout(ctx, PAYOUT)).toEqual({ error: `${E}.burnMayHaveBeenSent` });
    expect(cp.releasePayoutBurn).not.toHaveBeenCalled();
  });

  it("keeps the claim and surfaces the hash when the report fails", async () => {
    cp.burnPayout.mockRejectedValueOnce(new CitizenPayApiError("bad gateway", 502, null));
    expect(await burnPayout(ctx, PAYOUT)).toEqual({
      error: `${E}.reportFailed (tx ${TX})`,
    });
    expect(cp.releasePayoutBurn).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate burn as an error naming the hash", async () => {
    cp.burnPayout.mockResolvedValueOnce(report({ duplicateBurn: true }));
    expect(await burnPayout(ctx, PAYOUT)).toEqual({
      error: `${E}.duplicateBurn ${JSON.stringify({ txHash: TX })}`,
      duplicateBurn: true,
      txHash: TX,
    });
  });
});

describe("recordPayoutBurn", () => {
  beforeEach(() => {
    cp.getPayoutStatus.mockResolvedValue({
      status: "pending",
      burnClaim: { claimId: CLAIM.claimId, claimedAt: CLAIM.claimedAt, source: "external" },
    });
    verifyPayoutBurn.mockResolvedValue({ ok: true, txHash: TX });
  });

  it("verifies on chain, then reports like a burn (minter destination, no claim id)", async () => {
    const res = await recordPayoutBurn(ctx, { payoutId: PAYOUT, txHash: ` ${TX} ` });
    expect(res).toMatchObject({ ok: true, txHash: TX });
    expect(verifyPayoutBurn).toHaveBeenCalledWith({
      chainId: 100,
      hash: TX,
      token: TOKEN,
      from: PLACE,
      // net 48.75 at 6 decimals — the units burnDirect burns.
      amount: BigInt(48_750_000),
      decimals: 6,
    });
    expect(cp.burnPayout).toHaveBeenCalledWith(PAYOUT, TX, MINTER, undefined);
    expect(resolveOrEnqueueAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ userOpHash: "0xfee" }),
    );
    expect(burnDirect).not.toHaveBeenCalled();
    expect(cp.claimPayoutBurn).not.toHaveBeenCalled();
  });

  it("reports the settlement tx hash when a userOp hash was pasted", async () => {
    const userOp = `0x${"cd".repeat(32)}`;
    await recordPayoutBurn(ctx, { payoutId: PAYOUT, txHash: userOp });
    expect(verifyPayoutBurn).toHaveBeenCalledWith(expect.objectContaining({ hash: userOp }));
    expect(cp.burnPayout).toHaveBeenCalledWith(PAYOUT, TX, MINTER, undefined);
  });

  it.each([
    [{ reason: "notFound" }, `${E}.burnHashNotFound`],
    [{ reason: "notSuccessful" }, `${E}.burnHashNotSuccessful`],
    [{ reason: "notBurn" }, `${E}.burnHashNotBurn`],
    [
      { reason: "wrongAmount", found: "40", expected: "48.75" },
      `${E}.burnHashWrongAmount ${JSON.stringify({ found: "40", expected: "48.75" })}`,
    ],
  ])("refuses %j without reporting", async (check, message) => {
    verifyPayoutBurn.mockResolvedValueOnce(check);
    expect(await recordPayoutBurn(ctx, { payoutId: PAYOUT, txHash: TX })).toEqual({
      error: message,
    });
    expect(cp.burnPayout).not.toHaveBeenCalled();
  });

  it("refuses when the chain can't be read", async () => {
    verifyPayoutBurn.mockRejectedValueOnce(new Error("bundler down"));
    expect(await recordPayoutBurn(ctx, { payoutId: PAYOUT, txHash: TX })).toEqual({
      error: `${E}.burnVerifyFailed`,
    });
    expect(cp.burnPayout).not.toHaveBeenCalled();
  });

  it("rejects a malformed hash without calling CP", async () => {
    expect(await recordPayoutBurn(ctx, { payoutId: PAYOUT, txHash: "0x123" })).toEqual({
      error: `${E}.txHashInvalid`,
    });
    expect(cp.getPayoutStatus).not.toHaveBeenCalled();
    expect(cp.burnPayout).not.toHaveBeenCalled();
  });

  it("refuses when no claim is in flight (stale page)", async () => {
    cp.getPayoutStatus.mockResolvedValue({ status: "burnt", burnClaim: null });
    expect(await recordPayoutBurn(ctx, { payoutId: PAYOUT, txHash: TX })).toEqual({
      error: `${E}.noBurnClaim`,
    });
    expect(verifyPayoutBurn).not.toHaveBeenCalled();
    expect(cp.burnPayout).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate burn", async () => {
    cp.burnPayout.mockResolvedValueOnce(report({ duplicateBurn: true }));
    const res = await recordPayoutBurn(ctx, { payoutId: PAYOUT, txHash: TX });
    expect(res).toMatchObject({ duplicateBurn: true, txHash: TX });
  });
});

describe("releasePayoutBurnClaim", () => {
  it("force-releases, pinned to the claim the page showed", async () => {
    expect(await releasePayoutBurnClaim(ctx, PAYOUT, CLAIM.claimId)).toEqual({ ok: true });
    expect(cp.releasePayoutBurn).toHaveBeenCalledWith(PAYOUT, {
      claimId: CLAIM.claimId,
      force: true,
    });
  });

  it("explains when the claim is too recent to force-release", async () => {
    cp.releasePayoutBurn.mockRejectedValueOnce(
      new CitizenPayApiError("burn claim is too recent", 409, {
        error: "burn claim is too recent",
        claimedAt: "2026-10-05T09:30:00Z",
        releasableAt: "2026-10-05T09:40:00Z",
      }),
    );
    expect(await releasePayoutBurnClaim(ctx, PAYOUT, CLAIM.claimId)).toEqual({
      error: `${E}.releaseTooRecent ${JSON.stringify({ releasableAt: "2026-10-05 09:40 UTC" })}`,
    });
  });

  it("flags a claim that changed since the page loaded", async () => {
    cp.releasePayoutBurn.mockRejectedValueOnce(
      new CitizenPayApiError("burn claim does not match", 409, null),
    );
    expect(await releasePayoutBurnClaim(ctx, PAYOUT, CLAIM.claimId)).toEqual({
      error: `${E}.releaseClaimChanged`,
      stale: true,
    });
  });

  it("returns CP's message on any other failure", async () => {
    cp.releasePayoutBurn.mockRejectedValueOnce(
      new CitizenPayApiError("internal error", 500, null),
    );
    expect(await releasePayoutBurnClaim(ctx, PAYOUT, CLAIM.claimId)).toEqual({
      error: "internal error",
    });
  });
});
