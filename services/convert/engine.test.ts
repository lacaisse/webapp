// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The conversion engine end to end against the real Safe core
// (services/safe/proposals.ts on the in-memory Prisma of
// services/safe/test-fake-prisma.ts): quote → start (CoW order posted, first
// proposal) → execution hook → fill polled → continue (second proposal) →
// done. The chain, the CoW orderbook, the relayer, the Safe Transaction
// Service and the signer keys are faked; the legs, the walk, the order math
// and the Safe hashing / batching are real.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", async () => ({
  prisma: (await import("@/services/safe/test-fake-prisma")).fake.prisma,
}));

const relayer = vi.hoisted(() => ({
  isRelayerConfigured: vi.fn(),
  readSafeState: vi.fn(),
  deploySafe: vi.fn(),
  execSafeTransaction: vi.fn(),
  errorTxHash: vi.fn((e: unknown) => (e as { txHash?: string }).txHash ?? null),
  findSafeExecution: vi.fn(),
  verifyContractSignature: vi.fn(),
  hasContractCode: vi.fn(),
  deployPasskeySigner: vi.fn(),
  predictPasskeySignerAddress: vi.fn(),
  publicClientFor: vi.fn(),
}));
vi.mock("@/services/safe/relayer", () => relayer);

const txService = vi.hoisted(() => ({
  isTxServiceEnabled: vi.fn(),
  proposeTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  getMultisigTransaction: vi.fn(),
}));
vi.mock("@/services/safe/tx-service", () => txService);

const signer = vi.hoisted(() => ({ findFundSigner: vi.fn(), signSafeTxWithSigner: vi.fn() }));
vi.mock("@/services/safe/signer", () => signer);

const sync = vi.hoisted(() => ({ syncSafe: vi.fn() }));
vi.mock("@/services/safe/sync", () => sync);

const annotate = vi.hoisted(() => ({
  annotateTransaction: vi.fn(),
  ANNOTATION_KINDS: { safeTransfer: "SAFE_TRANSFER" },
  ANNOTATION_TRIGGERS: { safeTransfer: "SAFE_TRANSFER" },
}));
vi.mock("@/services/transaction-annotation/annotate", () => annotate);

const cowApi = vi.hoisted(() => ({
  requestQuote: vi.fn(),
  postPreSignOrder: vi.fn(),
  getOrder: vi.fn(),
  getTrades: vi.fn(),
  cowApiBaseUrl: vi.fn(() => "https://cow.test"),
}));
vi.mock("@/services/convert/cow-api", () => cowApi);

const chain = vi.hoisted(() => ({ holderBalance: vi.fn(), readSettledTrade: vi.fn() }));
vi.mock("@/services/convert/chain", () => chain);

const displayTokens = vi.hoisted(() => ({ getDisplayTokens: vi.fn() }));
vi.mock("@/services/token/display-tokens", () => displayTokens);

import { MULTISEND_CALL_ONLY_BY_CHAIN } from "@/services/safe/config";
import { withdrawProposal } from "@/services/safe/proposals";
import { decodeMultiSendCallOnly } from "@/services/safe/safe-tx";
import { fake, resetFake } from "@/services/safe/test-fake-prisma";
import type { SafeTxSummary } from "@/services/safe/types";

import { BREAD_CONTRACTS_BY_CHAIN, COW_CONTRACTS_BY_CHAIN, EURE_BY_CHAIN } from "./assets";
import { APP_DATA_HASH, orderUid } from "./cow-order";
import {
  ORDER_VALID_FOR_S,
  cancelConversion,
  continueConversion,
  quoteConversion,
  signingRounds,
  startConversion,
} from "./engine";
import { advanceConversions } from "./progress";
import { CONVERTERS } from "./registry";

const db = fake.db;
const SAFE = getAddress("0x5afe00000000000000000000000000000000cafe");
const A = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const B = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const C = getAddress("0xcccccccccccccccccccccccccccccccccccccccc");
const MSCO = MULTISEND_CALL_ONLY_BY_CHAIN[100];
const EURE = EURE_BY_CHAIN[100];
const { bread: BREAD, wxdai: WXDAI } = BREAD_CONTRACTS_BY_CHAIN[100];
const COW = COW_CONTRACTS_BY_CHAIN[100];
const EXEC_HASH = `0x${"e1".repeat(32)}` as const;
const SETTLE_HASH = `0x${"5e".repeat(32)}` as const;
const NOW = new Date("2026-11-02T12:00:00Z");
const E = (n: string) => BigInt(n) * BigInt("1000000000000000000"); // whole tokens → wei
const IN = E("50"); // 50 EURe
const QUOTED = E("56"); // 56 WXDAI
const MIN = (QUOTED * BigInt(9_950)) / BigInt(10_000); // 55.72 at 0.5 %
const FILLED = E("55") + BigInt("900000000000000000"); // 55.9

const FUND = {
  id: "fund-1",
  tokenChainId: 100,
  tokenAddress: getAddress("0x3333333333333333333333333333333333333333"),
  tokenDecimals: 6,
  tokenSymbol: "CAISSE",
  showNativeBalance: false,
  showEureBalance: true,
};
const DISPLAY = [
  { key: "eure", symbol: "EURe", decimals: 18, address: EURE },
  { key: `custom:${BREAD.toLowerCase()}`, symbol: "BREAD", decimals: 18, address: BREAD },
];

const sigFor = (enc: string) => `0x${enc.slice(-2).repeat(65)}` as `0x${string}`;
let safeId: string;

function seed(opts: { threshold: number; owners: { userId: string; address: string; byte: string }[] }) {
  for (const o of opts.owners) {
    db.user.push({ id: o.userId, name: `User ${o.userId}`, email: `${o.userId}@x.test` });
    db.fundMember.push({ fundId: FUND.id, userId: o.userId, role: "ADMIN" });
    db.fundSigner.push({ id: `signer-${o.userId}`, fundId: FUND.id, userId: o.userId, address: o.address, privateKeyEnc: `enc-${o.byte}` });
  }
  safeId = "safe-1";
  db.fundSafe.push({
    id: safeId,
    fundId: FUND.id,
    name: "Treasury",
    chainId: 100,
    saltNonce: "1",
    address: SAFE,
    threshold: opts.threshold,
    status: "ACTIVE",
    archivedAt: null,
    lastSyncedAt: null,
    configWarning: null,
  });
  for (const o of opts.owners) {
    db.fundSafeOwner.push({ id: `owner-${o.userId}`, safeId, address: o.address, kind: "MEMBER", signerId: `signer-${o.userId}`, label: null, removedAt: null });
  }
  relayer.readSafeState.mockResolvedValue({ deployed: true, owners: opts.owners.map((o) => o.address), threshold: opts.threshold, nonce: 0 });
}

const ONE_OF_ONE = { threshold: 1, owners: [{ userId: "u-a", address: A, byte: "1a" }] };
const TWO_OF_THREE = {
  threshold: 2,
  owners: [
    { userId: "u-a", address: A, byte: "1a" },
    { userId: "u-b", address: B, byte: "1b" },
    { userId: "u-c", address: C, byte: "1c" },
  ],
};

function cowQuote(buyAmount: bigint) {
  return {
    sellAmount: IN - E("0") - BigInt("150000000000000000"),
    feeAmount: BigInt("150000000000000000"),
    buyAmount,
    validTo: Math.floor(NOW.getTime() / 1000) + 1800,
    expiration: new Date(NOW.getTime() + 1800_000),
    id: 7,
  };
}

function summaryOf(i: number) {
  return db.fundSafeTransaction[i].summary as Extract<SafeTxSummary, { kind: "CONVERSION" }>;
}

async function quoteAndStart(converterId: string, amount = "50") {
  const quote = await quoteConversion({ fund: FUND, safeId, converterId, amount, slippageBps: 50, now: NOW });
  const started = await startConversion({
    fund: FUND,
    safeId,
    userId: "u-a",
    input: { converterId, amount, minOut: quote.minOut, slippageBps: 50 },
    now: NOW,
  });
  return { quote, started };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFake();
  relayer.isRelayerConfigured.mockReturnValue(true);
  relayer.execSafeTransaction.mockResolvedValue({ txHash: EXEC_HASH });
  txService.isTxServiceEnabled.mockReturnValue(false);
  signer.signSafeTxWithSigner.mockImplementation(async (s: { privateKeyEnc: string }) => sigFor(s.privateKeyEnc));
  signer.findFundSigner.mockImplementation(
    async (fundId: string, userId: string) => db.fundSigner.find((x) => x.fundId === fundId && x.userId === userId) ?? null,
  );
  sync.syncSafe.mockResolvedValue({ synced: true });
  displayTokens.getDisplayTokens.mockResolvedValue(DISPLAY);
  cowApi.requestQuote.mockResolvedValue(cowQuote(QUOTED));
  cowApi.postPreSignOrder.mockResolvedValue(undefined);
  chain.holderBalance.mockResolvedValue(E("1000"));
});

describe("registry", () => {
  it("EURe → BREAD takes two proposals, BREAD → EURe one", () => {
    expect(CONVERTERS.map((c) => [c.id, signingRounds(c)])).toEqual([
      ["eure-bread", 2],
      ["bread-eure", 1],
    ]);
  });
});

describe("EURe → BREAD on a 1-of-1 Safe", () => {
  it("quote → order posted + batch[approve, presign] executed → FILLING → fill → READY → batch[unwrap, mint] → DONE", async () => {
    seed(ONE_OF_ONE);

    const { quote, started } = await quoteAndStart("eure-bread");
    expect(quote).toMatchObject({
      converterId: "eure-bread",
      from: { symbol: "EURe", amount: "50" },
      to: { symbol: "BREAD", expected: "56", min: "55.72" },
      amountIn: IN.toString(),
      minOut: MIN.toString(),
      rounds: 2,
    });

    // The order: the whole input sold, the accepted minimum, a week's validity.
    expect(cowApi.postPreSignOrder).toHaveBeenCalledTimes(1);
    const posted = cowApi.postPreSignOrder.mock.calls[0][0];
    expect(posted.owner).toBe(SAFE);
    expect(posted.order).toMatchObject({
      sellToken: EURE,
      buyToken: WXDAI,
      receiver: SAFE,
      sellAmount: IN,
      buyAmount: MIN,
      feeAmount: BigInt(0),
      kind: "sell",
      partiallyFillable: false,
      appData: APP_DATA_HASH,
      validTo: Math.floor(NOW.getTime() / 1000) + ORDER_VALID_FOR_S,
    });
    expect(posted.uid).toBe(orderUid(100, COW.settlement, posted.order, SAFE));

    // Proposal 1: a MultiSendCallOnly batch of approve + presign, executed at once.
    expect(started.proposal.executed).toBe(true);
    const tx1 = db.fundSafeTransaction[0];
    expect(tx1).toMatchObject({ kind: "CONVERSION", operation: 1, to: MSCO, status: "EXECUTED", conversionId: started.conversionId });
    const inner1 = decodeMultiSendCallOnly(tx1.data as `0x${string}`);
    expect(inner1.map((c) => [c.to, c.value])).toEqual([
      [EURE, BigInt(0)],
      [COW.settlement, BigInt(0)],
    ]);
    expect(summaryOf(0)).toMatchObject({
      kind: "CONVERSION",
      converterId: "eure-bread",
      step: 1,
      steps: 2,
      label: "swap",
      from: { symbol: "EURe", amount: "50" },
      to: { symbol: "BREAD", minAmount: "55.72" },
      calls: [
        { to: EURE, label: "approve" },
        { to: COW.settlement, label: "presign" },
      ],
    });

    // The execution hook moved the conversion to FILLING.
    const row = () => db.fundConversion.find((c) => c.id === started.conversionId)!;
    expect(row()).toMatchObject({ status: "FILLING", round: 1, amountOut: null, minOut: MIN.toString() });

    // The cron: the order filled; the chain confirms the Trade.
    cowApi.getOrder.mockResolvedValue({ uid: posted.uid, status: "fulfilled", executedSellAmount: IN, executedBuyAmount: FILLED, invalidated: false, validTo: posted.order.validTo });
    cowApi.getTrades.mockResolvedValue([{ orderUid: posted.uid, owner: SAFE, sellAmount: IN, buyAmount: FILLED, txHash: SETTLE_HASH, blockNumber: 1, logIndex: 0 }]);
    chain.readSettledTrade.mockResolvedValue({ sellAmount: IN, buyAmount: FILLED, feeAmount: BigInt(0) });
    const tick = await advanceConversions(new Date(NOW.getTime() + 60_000));
    expect(tick).toMatchObject({ polled: 1, filled: 1, errors: [] });
    expect(chain.readSettledTrade).toHaveBeenCalledWith({ chainId: 100, txHash: SETTLE_HASH, orderUid: posted.uid });
    expect(row().status).toBe("READY");

    // An owner continues: the mint, sized to the fill, as proposal 2.
    chain.holderBalance.mockResolvedValue(FILLED);
    const second = await continueConversion({ fund: FUND, safeId, userId: "u-a", conversionId: started.conversionId, now: NOW });
    expect(second.executed).toBe(true);
    expect(chain.holderBalance).toHaveBeenLastCalledWith({ chainId: 100, holder: SAFE, token: WXDAI });
    const tx2 = db.fundSafeTransaction[1];
    expect(tx2).toMatchObject({ kind: "CONVERSION", operation: 1, to: MSCO, status: "EXECUTED", conversionId: started.conversionId });
    expect(decodeMultiSendCallOnly(tx2.data as `0x${string}`).map((c) => [c.to, c.value])).toEqual([
      [WXDAI, BigInt(0)],
      [BREAD, FILLED],
    ]);
    expect(summaryOf(1)).toMatchObject({
      step: 2,
      steps: 2,
      label: "mint",
      calls: [
        { to: WXDAI, label: "unwrap" },
        { to: BREAD, label: "mint", value: FILLED.toString() },
      ],
    });
    expect(row()).toMatchObject({ status: "DONE", round: 2, amountOut: FILLED.toString() });
    expect(row().completedAt).toBeInstanceOf(Date);
  });

  it("refuses to start when the fresh minimum is below what the user accepted, writing nothing", async () => {
    seed(ONE_OF_ONE);
    const quote = await quoteConversion({ fund: FUND, safeId, converterId: "eure-bread", amount: "50", slippageBps: 50, now: NOW });
    cowApi.requestQuote.mockResolvedValue(cowQuote(E("55"))); // the market moved
    await expect(
      startConversion({ fund: FUND, safeId, userId: "u-a", input: { converterId: "eure-bread", amount: "50", minOut: quote.minOut, slippageBps: 50 }, now: NOW }),
    ).rejects.toMatchObject({ code: "quote_moved" });
    expect(cowApi.postPreSignOrder).not.toHaveBeenCalled();
    expect(db.fundConversion).toHaveLength(0);
    expect(db.fundSafeTransaction).toHaveLength(0);
  });

  it("posts no less than the accepted minimum when the fresh quote is better", async () => {
    seed(ONE_OF_ONE);
    const quote = await quoteConversion({ fund: FUND, safeId, converterId: "eure-bread", amount: "50", slippageBps: 50, now: NOW });
    cowApi.requestQuote.mockResolvedValue(cowQuote(E("57")));
    await startConversion({ fund: FUND, safeId, userId: "u-a", input: { converterId: "eure-bread", amount: "50", minOut: quote.minOut, slippageBps: 50 }, now: NOW });
    const freshMin = (E("57") * BigInt(9_950)) / BigInt(10_000);
    expect(cowApi.postPreSignOrder.mock.calls[0][0].order.buyAmount).toBe(freshMin);
    expect(db.fundConversion[0].minOut).toBe(freshMin.toString());
  });

  it("refuses to start when the Safe does not hold the input", async () => {
    seed(ONE_OF_ONE);
    chain.holderBalance.mockResolvedValue(E("10"));
    await expect(quoteAndStart("eure-bread")).rejects.toMatchObject({ code: "funds_moved" });
    expect(db.fundConversion).toHaveLength(0);
  });

  it("refuses a pair the fund does not show, and a bad amount", async () => {
    seed(ONE_OF_ONE);
    displayTokens.getDisplayTokens.mockResolvedValue([DISPLAY[0]]); // no BREAD
    await expect(quoteConversion({ fund: FUND, safeId, converterId: "eure-bread", amount: "50", slippageBps: 50, now: NOW })).rejects.toMatchObject({ code: "no_pair" });
    displayTokens.getDisplayTokens.mockResolvedValue(DISPLAY);
    await expect(quoteConversion({ fund: FUND, safeId, converterId: "eure-bread", amount: "0", slippageBps: 50, now: NOW })).rejects.toMatchObject({ code: "amount" });
    await expect(quoteConversion({ fund: FUND, safeId, converterId: "eure-bread", amount: "1.0000000000000000001", slippageBps: 50, now: NOW })).rejects.toMatchObject({ code: "amount" });
  });

  it("an expired order ends the conversion EXPIRED; a fill below the minimum ends it FAILED", async () => {
    seed(ONE_OF_ONE);
    const { started } = await quoteAndStart("eure-bread");
    const uid = cowApi.postPreSignOrder.mock.calls[0][0].uid;
    cowApi.getOrder.mockResolvedValue({ uid, status: "expired", executedSellAmount: BigInt(0), executedBuyAmount: BigInt(0), invalidated: false, validTo: 1 });
    await advanceConversions(NOW);
    expect(db.fundConversion.find((c) => c.id === started.conversionId)).toMatchObject({ status: "EXPIRED" });

    resetFake();
    seed(ONE_OF_ONE);
    const again = await quoteAndStart("eure-bread");
    const uid2 = cowApi.postPreSignOrder.mock.calls[1][0].uid;
    cowApi.getOrder.mockResolvedValue({ uid: uid2, status: "fulfilled", executedSellAmount: IN, executedBuyAmount: E("50"), invalidated: false, validTo: 1 });
    cowApi.getTrades.mockResolvedValue([{ orderUid: uid2, owner: SAFE, sellAmount: IN, buyAmount: E("50"), txHash: SETTLE_HASH, blockNumber: 1, logIndex: 0 }]);
    chain.readSettledTrade.mockResolvedValue({ sellAmount: IN, buyAmount: E("50"), feeAmount: BigInt(0) });
    const tick = await advanceConversions(NOW);
    expect(tick.failed).toBe(1);
    expect(db.fundConversion.find((c) => c.id === again.started.conversionId)).toMatchObject({ status: "FAILED" });
    expect(db.fundConversion[0].errorMessage).toMatch(/below the order minimum/);
  });

  it("a pending order is left alone; indexer lag (fulfilled, no trade yet) too", async () => {
    seed(ONE_OF_ONE);
    const { started } = await quoteAndStart("eure-bread");
    const uid = cowApi.postPreSignOrder.mock.calls[0][0].uid;
    cowApi.getOrder.mockResolvedValue({ uid, status: "open", executedSellAmount: BigInt(0), executedBuyAmount: BigInt(0), invalidated: false, validTo: Math.floor(NOW.getTime() / 1000) + 600 });
    expect(await advanceConversions(NOW)).toMatchObject({ polled: 1, filled: 0 });
    cowApi.getOrder.mockResolvedValue({ uid, status: "fulfilled", executedSellAmount: IN, executedBuyAmount: FILLED, invalidated: false, validTo: 1 });
    cowApi.getTrades.mockResolvedValue([]);
    expect(await advanceConversions(NOW)).toMatchObject({ polled: 1, filled: 0 });
    expect(db.fundConversion.find((c) => c.id === started.conversionId)).toMatchObject({ status: "FILLING" });
  });
});

describe("BREAD → EURe on a 1-of-1 Safe", () => {
  it("one batch[burn, wrap, approve, presign] → FILLING → fill → DONE", async () => {
    seed(ONE_OF_ONE);
    const { quote, started } = await quoteAndStart("bread-eure");
    expect(quote).toMatchObject({ from: { symbol: "BREAD", amount: "50" }, to: { symbol: "EURe" }, rounds: 1 });
    expect(chain.holderBalance).toHaveBeenCalledWith({ chainId: 100, holder: SAFE, token: BREAD });

    const tx = db.fundSafeTransaction[0];
    expect(tx).toMatchObject({ kind: "CONVERSION", operation: 1, to: MSCO, status: "EXECUTED" });
    expect(decodeMultiSendCallOnly(tx.data as `0x${string}`).map((c) => [c.to, c.value])).toEqual([
      [BREAD, BigInt(0)],
      [WXDAI, IN], // wrap carries the burnt xDAI
      [WXDAI, BigInt(0)], // approve
      [COW.settlement, BigInt(0)], // presign
    ]);
    expect(summaryOf(0)).toMatchObject({ step: 1, steps: 1, calls: [{ label: "burn" }, { label: "wrap" }, { label: "approve" }, { label: "presign" }] });
    const posted = cowApi.postPreSignOrder.mock.calls[0][0];
    expect(posted.order).toMatchObject({ sellToken: WXDAI, buyToken: EURE, sellAmount: IN });

    const row = () => db.fundConversion.find((c) => c.id === started.conversionId)!;
    expect(row().status).toBe("FILLING");
    // Both legs recorded the batch: the burn is done, the swap waits.
    const state = row().state as { legs: { results: { kind: string }[] }[] };
    expect(state.legs.map((l) => l.results.map((r) => r.kind))).toEqual([["calls"], ["api", "calls"]]);

    cowApi.getOrder.mockResolvedValue({ uid: posted.uid, status: "fulfilled", executedSellAmount: IN, executedBuyAmount: FILLED, invalidated: false, validTo: 1 });
    cowApi.getTrades.mockResolvedValue([{ orderUid: posted.uid, owner: SAFE, sellAmount: IN, buyAmount: FILLED, txHash: SETTLE_HASH, blockNumber: 1, logIndex: 0 }]);
    chain.readSettledTrade.mockResolvedValue({ sellAmount: IN, buyAmount: FILLED, feeAmount: BigInt(0) });
    await advanceConversions(NOW);
    expect(row()).toMatchObject({ status: "DONE", amountOut: FILLED.toString() });
  });
});

describe("multisig: a proposal that waits, is withdrawn, or whose hook was missed", () => {
  it("stays PROPOSED while signatures are collected; withdrawing hands it back to READY; READY can be cancelled", async () => {
    seed(TWO_OF_THREE);
    const { started } = await quoteAndStart("eure-bread");
    expect(started.proposal.executed).toBe(false);
    const row = () => db.fundConversion.find((c) => c.id === started.conversionId)!;
    expect(row().status).toBe("PROPOSED");
    expect(db.fundSafeTransaction[0].status).toBe("PENDING");

    await withdrawProposal({ fundId: FUND.id, safeId, transactionId: started.proposal.transactionId, userId: "u-a", isFundOwner: false });
    expect(db.fundSafeTransaction).toHaveLength(0);
    expect(row().status).toBe("READY");

    // FILLING cannot be cancelled (an order is out); READY can.
    await cancelConversion({ fund: FUND, safeId, conversionId: started.conversionId, now: NOW });
    expect(row()).toMatchObject({ status: "CANCELLED" });
    await expect(cancelConversion({ fund: FUND, safeId, conversionId: started.conversionId })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(continueConversion({ fund: FUND, safeId, userId: "u-a", conversionId: started.conversionId })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("continuing re-proposes the same batch (the order is still out) and counts the round", async () => {
    seed(TWO_OF_THREE);
    const { started } = await quoteAndStart("eure-bread");
    await withdrawProposal({ fundId: FUND.id, safeId, transactionId: started.proposal.transactionId, userId: "u-a", isFundOwner: false });
    const res = await continueConversion({ fund: FUND, safeId, userId: "u-b", conversionId: started.conversionId, now: NOW });
    expect(res.executed).toBe(false);
    expect(cowApi.postPreSignOrder).toHaveBeenCalledTimes(1); // not posted again
    expect(db.fundSafeTransaction).toHaveLength(1);
    expect(summaryOf(0)).toMatchObject({ step: 2, label: "swap" });
    expect(db.fundConversion[0]).toMatchObject({ status: "PROPOSED", round: 2 });
  });

  it("the cron repairs a PROPOSED row whose proposal executed (hook missed) or vanished", async () => {
    seed(ONE_OF_ONE);
    const { started } = await quoteAndStart("eure-bread");
    const row = db.fundConversion.find((c) => c.id === started.conversionId)!;
    expect(row.status).toBe("FILLING");
    // Pretend the hook never ran: back to PROPOSED with the batch unrecorded.
    const state = row.state as { legs: { results: unknown[] }[] };
    state.legs[0].results = state.legs[0].results.filter((r) => (r as { kind: string }).kind === "api");
    Object.assign(row, { status: "PROPOSED", updatedAt: new Date(NOW.getTime() - 10 * 60_000) });
    const tick = await advanceConversions(NOW);
    expect(tick.repaired).toBe(1);
    expect(row.status).toBe("FILLING");

    // And a PROPOSED row with no proposal left at all: READY.
    Object.assign(row, { status: "PROPOSED", round: 2, updatedAt: new Date(NOW.getTime() - 10 * 60_000) });
    await advanceConversions(NOW);
    expect(row.status).toBe("READY");
  });
});
