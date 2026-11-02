// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { decodeFunctionData, formatUnits, getAddress, parseUnits } from "viem";

import { prisma } from "@/services/db/prisma";
import { proposeConversionStep, type ProposeResult } from "@/services/safe/proposals";
import type { SafeTxSummary } from "@/services/safe/types";
import type { DisplayTokensFund } from "@/services/token/display-tokens";
import type { ExtraToken } from "@/services/token/extra-tokens";

import { COW_CONTRACTS_BY_CHAIN, assetAddress } from "./assets";
import { holderBalance } from "./chain";
import { ERC20_APPROVE_ABI } from "./cow-order";
import { runApiSteps, stateOf, walkRow } from "./progress";
import { converterById, offeredPairs, type OfferedPair } from "./registry";
import {
  ConvertError,
  legQuoteToJson,
  type Address,
  type Call,
  type ConversionState,
  type Converter,
  type LegQuote,
} from "./types";
import { converterContracts, quoteChain, type Position } from "./walk";

// Quote / start / continue / cancel — the parts of a conversion that create
// Safe proposals (through proposals.ts proposeConversionStep). What happens
// after a proposal executes lives in progress.ts. Module map:
// services/convert/assets.ts.

// A CoW pre-sign order has no maximum validity; a week leaves room for the
// owners' signatures without an order hanging around for ever.
export const ORDER_VALID_FOR_S = 7 * 24 * 3600;
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 300;

const APPROVE_SELECTOR = "0x095ea7b3";

export type ConvertFund = DisplayTokensFund;

async function pairFor(fund: ConvertFund, converterId: string): Promise<OfferedPair> {
  const pair = (await offeredPairs(fund)).find((p) => p.converter.id === converterId);
  if (!pair) throw new ConvertError("no_pair", `Converter ${converterId} is not offered to this fund`);
  return pair;
}

async function loadActiveSafe(fund: ConvertFund, safeId: string) {
  const safe = await prisma.fundSafe.findFirst({
    where: { id: safeId, fundId: fund.id, archivedAt: null },
    select: { id: true, chainId: true, address: true, status: true },
  });
  if (!safe) throw new ConvertError("not_found", "Safe not found");
  if (safe.status !== "ACTIVE") throw new ConvertError("invalid_state", "Safe is not active");
  if (safe.chainId !== fund.tokenChainId) {
    throw new ConvertError("config", "Safe and fund token are on different chains");
  }
  return { id: safe.id, chainId: safe.chainId, address: getAddress(safe.address) };
}

function parseAmount(amount: string, token: ExtraToken): bigint {
  const fraction = amount.split(".")[1] ?? "";
  if (fraction.length > token.decimals) throw new ConvertError("amount", "Amount has too many decimals");
  let units: bigint;
  try {
    units = parseUnits(amount, token.decimals);
  } catch (e) {
    throw new ConvertError("amount", "Invalid amount", { cause: e });
  }
  if (units <= BigInt(0)) throw new ConvertError("amount", "Amount must be positive");
  return units;
}

/** How many Safe proposals a converter takes: one per swap, plus one for a trailing exact leg. */
export function signingRounds(converter: Converter): number {
  let rounds = 0;
  let pendingExact = false;
  for (const leg of converter.legs) {
    if (leg.exact) pendingExact = true;
    else {
      rounds++;
      pendingExact = false;
    }
  }
  return rounds + (pendingExact ? 1 : 0);
}

export type ConversionQuote = {
  converterId: string;
  from: { symbol: string; decimals: number; amount: string }; // human amounts
  to: { symbol: string; decimals: number; expected: string; min: string };
  amountIn: string; // raw units
  expectedOut: string;
  minOut: string;
  slippageBps: number;
  rounds: number; // Safe proposals the conversion takes
  validUntil: string; // ISO: the order's validTo
};

export async function quoteConversion(a: {
  fund: ConvertFund;
  safeId: string;
  converterId: string;
  amount: string;
  slippageBps: number;
  now?: Date;
}): Promise<ConversionQuote> {
  const now = a.now ?? new Date();
  const pair = await pairFor(a.fund, a.converterId);
  const safe = await loadActiveSafe(a.fund, a.safeId);
  const units = parseAmount(a.amount, pair.from);
  const q = await quoteChain(pair.converter, {
    chainId: safe.chainId,
    holder: safe.address,
    amountIn: units,
    slippageBps: a.slippageBps,
    validFor: ORDER_VALID_FOR_S,
    now,
  });
  return {
    converterId: pair.converter.id,
    from: { symbol: pair.from.symbol, decimals: pair.from.decimals, amount: formatUnits(units, pair.from.decimals) },
    to: {
      symbol: pair.to.symbol,
      decimals: pair.to.decimals,
      expected: formatUnits(q.expectedOut, pair.to.decimals),
      min: formatUnits(q.minOut, pair.to.decimals),
    },
    amountIn: units.toString(),
    expectedOut: q.expectedOut.toString(),
    minOut: q.minOut.toString(),
    slippageBps: a.slippageBps,
    rounds: signingRounds(pair.converter),
    validUntil: q.validUntil.toISOString(),
  };
}

// Every call of a step must target one of the converter's contracts, and an
// ERC-20 approval may only be the exact sell amount to CoW's vault relayer.
// A leg could never do otherwise today; this keeps a future leg honest.
export function checkCalls(a: { converter: Converter; chainId: number; position: Position }): void {
  const allowed = converterContracts(a.converter, a.chainId);
  const cow = COW_CONTRACTS_BY_CHAIN[a.chainId];
  if (a.position.step.kind !== "calls") throw new ConvertError("invalid_state", "Not a calls step");
  for (const call of a.position.step.calls) {
    if (!allowed.has(getAddress(call.to))) {
      throw new ConvertError("contract_refused", `Call to ${call.to} is outside the converter's contracts`);
    }
    if (call.data.toLowerCase().startsWith(APPROVE_SELECTOR)) {
      const { args } = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: call.data });
      const [spender, amount] = args as readonly [Address, bigint];
      if (!cow || getAddress(spender) !== getAddress(cow.vaultRelayer)) {
        throw new ConvertError("contract_refused", `Approval to ${spender} is not the CoW vault relayer`);
      }
      if (amount !== a.position.amountIn) {
        throw new ConvertError("contract_refused", `Approval of ${amount} is not the step's input ${a.position.amountIn}`);
      }
    }
  }
}

function summaryFor(a: {
  conversionId: string;
  converter: Converter;
  step: number;
  position: Position;
  from: { symbol: string; decimals: number; amountIn: bigint };
  to: { symbol: string; decimals: number; minOut: bigint };
  validUntil: Date | null;
}): Extract<SafeTxSummary, { kind: "CONVERSION" }> {
  if (a.position.step.kind !== "calls") throw new ConvertError("invalid_state", "Not a calls step");
  return {
    kind: "CONVERSION",
    conversionId: a.conversionId,
    converterId: a.converter.id,
    step: a.step,
    steps: signingRounds(a.converter),
    label: a.position.step.label,
    from: { symbol: a.from.symbol, amount: formatUnits(a.from.amountIn, a.from.decimals) },
    to: { symbol: a.to.symbol, minAmount: formatUnits(a.to.minOut, a.to.decimals) },
    ...(a.validUntil ? { validUntil: a.validUntil.toISOString() } : {}),
    calls: a.position.step.calls.map((c: Call) => ({
      to: c.to,
      label: c.label,
      ...(c.value > BigInt(0) ? { value: c.value.toString() } : {}),
    })),
  };
}

// The holder must still hold the step's input (the conversion's input for
// the first step; the WXDAI a fill left behind for a mint).
async function requireHolderBalance(a: {
  chainId: number;
  holder: Address;
  converter: Converter;
  position: Position;
}): Promise<void> {
  const inputLeg = a.converter.legs[a.position.appliesTo[0]];
  const balance = await holderBalance({ chainId: a.chainId, holder: a.holder, token: assetAddress(inputLeg.from) });
  if (balance < a.position.amountIn) {
    throw new ConvertError(
      "funds_moved",
      `Holder has ${balance} of ${inputLeg.from}, the step needs ${a.position.amountIn}`,
    );
  }
}

export type StartConversionInput = {
  converterId: string;
  amount: string; // human decimal
  minOut: string; // raw units the user accepted (from the quote they saw)
  slippageBps: number;
};

/**
 * Start a conversion: re-quote, refuse if the market moved below what the
 * user accepted, run the api steps (post the CoW order), then create the
 * row and its first Safe proposal. Nothing is written if the order cannot be
 * posted; the row is removed if the proposal cannot be made (the posted
 * order is never pre-signed, so it can never fill).
 */
export async function startConversion(a: {
  fund: ConvertFund;
  safeId: string;
  userId: string;
  input: StartConversionInput;
  now?: Date;
}): Promise<{ conversionId: string; proposal: ProposeResult }> {
  const now = a.now ?? new Date();
  const pair = await pairFor(a.fund, a.input.converterId);
  const { converter } = pair;
  const safe = await loadActiveSafe(a.fund, a.safeId);
  const amountIn = parseAmount(a.input.amount, pair.from);
  if (!/^\d+$/.test(a.input.minOut)) throw new ConvertError("amount", "Bad minimum");
  const userMin = BigInt(a.input.minOut);

  const fresh = await quoteChain(converter, {
    chainId: safe.chainId,
    holder: safe.address,
    amountIn,
    slippageBps: a.input.slippageBps,
    validFor: ORDER_VALID_FOR_S,
    now,
  });
  if (fresh.minOut < userMin) {
    throw new ConvertError("quote_moved", `Fresh minimum ${fresh.minOut} is below the accepted ${userMin}`);
  }
  // The minimum the user accepted is the minimum posted. With one swap leg
  // (all registered converters) the overall minimum IS that leg's minimum;
  // a second swap leg would need its own share of it.
  const swapLegs = converter.legs.filter((l) => !l.exact);
  if (swapLegs.length > 1) throw new ConvertError("invalid_state", "Converters with two swap legs are not supported");
  const legs: LegQuote[] = fresh.legs.map((q, i) =>
    converter.legs[i].exact ? q : { ...q, minAmountOut: q.minAmountOut > userMin ? q.minAmountOut : userMin },
  );
  const minOut = fresh.minOut > userMin ? fresh.minOut : userMin;

  const state: ConversionState = { legs: legs.map((q) => ({ quote: legQuoteToJson(q), results: [] })) };
  const w = await runApiSteps({
    converterId: converter.id,
    chainId: safe.chainId,
    holder: safe.address,
    amountIn,
    state,
    now,
  });
  if (w.done || w.position.step.kind !== "calls") {
    throw new ConvertError("invalid_state", "Conversion does not start with an on-chain step");
  }
  checkCalls({ converter, chainId: safe.chainId, position: w.position });
  await requireHolderBalance({ chainId: safe.chainId, holder: safe.address, converter, position: w.position });

  const row = await prisma.fundConversion.create({
    data: {
      fundId: a.fund.id,
      holderKind: "SAFE",
      safeId: safe.id,
      holderAddress: safe.address,
      converterId: converter.id,
      fromAsset: converter.legs[0].from,
      toAsset: converter.legs[converter.legs.length - 1].to,
      amountIn: amountIn.toString(),
      expectedOut: fresh.expectedOut.toString(),
      minOut: minOut.toString(),
      slippageBps: a.input.slippageBps,
      status: "PROPOSED",
      round: 1,
      state: state as never,
      validUntil: fresh.validUntil,
      createdById: a.userId,
    },
    select: { id: true },
  });
  try {
    const proposal = await proposeConversionStep({
      fund: { id: a.fund.id, tokenChainId: a.fund.tokenChainId },
      safeId: safe.id,
      userId: a.userId,
      conversionId: row.id,
      calls: w.position.step.calls,
      summary: summaryFor({
        conversionId: row.id,
        converter,
        step: 1,
        position: w.position,
        from: { symbol: pair.from.symbol, decimals: pair.from.decimals, amountIn },
        to: { symbol: pair.to.symbol, decimals: pair.to.decimals, minOut },
        validUntil: fresh.validUntil,
      }),
    });
    return { conversionId: row.id, proposal };
  } catch (e) {
    await prisma.fundConversion.delete({ where: { id: row.id } }).catch(() => undefined);
    throw e;
  }
}

/** Propose the next on-chain step of a READY conversion (an owner's click). */
export async function continueConversion(a: {
  fund: ConvertFund;
  safeId: string;
  userId: string;
  conversionId: string;
  now?: Date;
}): Promise<ProposeResult> {
  const now = a.now ?? new Date();
  const row = await prisma.fundConversion.findFirst({
    where: { id: a.conversionId, fundId: a.fund.id, safeId: a.safeId },
  });
  if (!row) throw new ConvertError("not_found", "Conversion not found");
  if (row.status !== "READY") throw new ConvertError("invalid_state", `Conversion is ${row.status}`);
  const pair = await pairFor(a.fund, row.converterId);
  const { converter } = pair;
  const safe = await loadActiveSafe(a.fund, a.safeId);
  const state = stateOf(row);
  const w = walkRow(row, state, now);
  if (w.done || w.position.step.kind !== "calls") {
    throw new ConvertError("invalid_state", "Conversion has no on-chain step to propose");
  }
  checkCalls({ converter, chainId: safe.chainId, position: w.position });
  try {
    await requireHolderBalance({ chainId: safe.chainId, holder: safe.address, converter, position: w.position });
  } catch (e) {
    if (e instanceof ConvertError && e.code === "funds_moved") {
      await prisma.fundConversion.updateMany({
        where: { id: row.id, status: "READY" },
        data: { status: "FAILED", errorMessage: e.message, completedAt: now },
      });
    }
    throw e;
  }

  const claim = await prisma.fundConversion.updateMany({
    where: { id: row.id, fundId: a.fund.id, status: "READY" },
    data: { status: "PROPOSED", round: row.round + 1 },
  });
  if (claim.count === 0) throw new ConvertError("invalid_state", "Conversion already changed");
  try {
    return await proposeConversionStep({
      fund: { id: a.fund.id, tokenChainId: a.fund.tokenChainId },
      safeId: safe.id,
      userId: a.userId,
      conversionId: row.id,
      calls: w.position.step.calls,
      summary: summaryFor({
        conversionId: row.id,
        converter,
        step: row.round + 1,
        position: w.position,
        from: { symbol: pair.from.symbol, decimals: pair.from.decimals, amountIn: BigInt(row.amountIn) },
        to: { symbol: pair.to.symbol, decimals: pair.to.decimals, minOut: BigInt(row.minOut) },
        validUntil: row.validUntil,
      }),
    });
  } catch (e) {
    await prisma.fundConversion.updateMany({
      where: { id: row.id, status: "PROPOSED", round: row.round + 1 },
      data: { status: "READY", round: row.round },
    });
    throw e;
  }
}

/** Cancel a conversion that waits for an owner (READY): nothing is in flight. */
export async function cancelConversion(a: {
  fund: ConvertFund;
  safeId: string;
  conversionId: string;
  now?: Date;
}): Promise<void> {
  const res = await prisma.fundConversion.updateMany({
    where: { id: a.conversionId, fundId: a.fund.id, safeId: a.safeId, status: "READY" },
    data: { status: "CANCELLED", completedAt: a.now ?? new Date() },
  });
  if (res.count === 0) {
    throw new ConvertError("invalid_state", "Only a conversion waiting for a proposal can be cancelled");
  }
}

export { converterById };
