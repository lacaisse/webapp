// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress } from "viem";

import { COW_CONTRACTS_BY_CHAIN, assetAddress, assetChainId } from "../assets";
import { readSettledTrade } from "../chain";
import { getOrder, getTrades, postPreSignOrder, requestQuote } from "../cow-api";
import {
  APP_DATA_DOC,
  APP_DATA_HASH,
  applySlippage,
  erc20ApproveData,
  orderFromJson,
  orderFromQuote,
  orderToJson,
  orderUid,
  setPreSignatureData,
  type JsonCowOrder,
} from "../cow-order";
import {
  ConvertError,
  type Erc20AssetId,
  type Hex,
  type Leg,
  type LegContext,
  type PollResult,
  type StepResult,
} from "../types";

// The CoW swap leg: any ERC-20 → ERC-20 on a chain CoW serves, as a fee-less,
// fill-or-kill pre-sign order owned by the holder. Three steps:
//   api   — post the order (uid computed locally; a duplicate is ours)
//   calls — approve the exact sell amount to the vault relayer, then
//           setPreSignature(uid, true) on the settlement contract
//   wait  — the orderbook reports the fill; the amount is then read from the
//           settlement transaction's Trade event, never from the API alone.
// Server-only: quote / run / poll call the orderbook and the chain. Module
// map: services/convert/assets.ts.

type QuoteData = { sellAmount: string; feeAmount: string; buyAmount: string; quoteId: number | null };
type ApiData = { order: JsonCowOrder };

function cowFor(chainId: number) {
  const c = COW_CONTRACTS_BY_CHAIN[chainId];
  if (!c) throw new ConvertError("config", `CoW is not configured for chain ${chainId}`);
  return c;
}

function quoteData(c: LegContext): QuoteData {
  const d = c.quote.data as Partial<QuoteData> | undefined;
  if (!d || typeof d.sellAmount !== "string" || typeof d.feeAmount !== "string" || typeof d.buyAmount !== "string") {
    throw new ConvertError("invalid_state", "CoW leg has no quote data");
  }
  return { sellAmount: d.sellAmount, feeAmount: d.feeAmount, buyAmount: d.buyAmount, quoteId: d.quoteId ?? null };
}

function postedOrder(c: LegContext): { uid: Hex; order: JsonCowOrder } {
  const api = c.results.find((r) => r.kind === "api");
  if (!api) throw new ConvertError("invalid_state", "CoW order not posted yet");
  const order = (api.data as Partial<ApiData> | undefined)?.order;
  if (!order) throw new ConvertError("invalid_state", "CoW order data missing");
  return { uid: api.ref as Hex, order };
}

export function cowLeg(from: Erc20AssetId, to: Erc20AssetId): Leg {
  const chainId = assetChainId(from);
  if (assetChainId(to) !== chainId) throw new Error("CoW leg: assets on different chains");
  const sellToken = assetAddress(from)!;
  const buyToken = assetAddress(to)!;

  return {
    id: "cow-swap",
    from,
    to,
    exact: false,
    contracts: (c) => [sellToken, cowFor(c).settlement],

    quote: async (r) => {
      if (r.chainId !== chainId) throw new ConvertError("config", "CoW leg: wrong chain");
      if (r.amountIn <= BigInt(0)) throw new ConvertError("amount", "Amount must be positive");
      const q = await requestQuote(r.chainId, {
        sellToken,
        buyToken,
        owner: r.holder,
        sellAmountBeforeFee: r.amountIn,
        appDataDoc: APP_DATA_DOC,
        appDataHash: APP_DATA_HASH,
        validFor: r.validFor,
      });
      if (q.buyAmount <= BigInt(0)) throw new ConvertError("quote_failed", "CoW quoted nothing");
      const data: QuoteData = {
        sellAmount: q.sellAmount.toString(),
        feeAmount: q.feeAmount.toString(),
        buyAmount: q.buyAmount.toString(),
        quoteId: q.id,
      };
      return {
        amountIn: r.amountIn,
        amountOut: q.buyAmount,
        minAmountOut: applySlippage(q.buyAmount, r.slippageBps),
        validUntil: new Date(r.now.getTime() + r.validFor * 1000),
        data,
      };
    },

    next: (c) => {
      if (!c.results.some((r) => r.kind === "api")) return { kind: "api", label: "post-order" };
      if (!c.results.some((r) => r.kind === "calls")) {
        const { uid } = postedOrder(c);
        const { vaultRelayer, settlement } = cowFor(c.chainId);
        return {
          kind: "calls",
          label: "swap",
          calls: [
            { to: sellToken, value: BigInt(0), data: erc20ApproveData(vaultRelayer, c.amountIn), label: "approve" },
            { to: settlement, value: BigInt(0), data: setPreSignatureData(uid, true), label: "presign" },
          ],
        };
      }
      if (!c.results.some((r) => r.kind === "wait")) return { kind: "wait", label: "fill" };
      return null;
    },

    output: (c) => {
      const w = c.results.find((r) => r.kind === "wait");
      return w ? BigInt(w.amountOut) : null;
    },

    run: async (c): Promise<StepResult> => {
      const q = quoteData(c);
      // The quote was taken for exactly this input; a different actual input
      // (an upstream leg that is not exact) needs a fresh quote first.
      if (BigInt(q.sellAmount) + BigInt(q.feeAmount) !== c.amountIn) {
        throw new ConvertError("quote_moved", "CoW leg input differs from its quote; re-quote");
      }
      const order = orderFromQuote({
        sellToken,
        buyToken,
        receiver: c.holder,
        quote: { sellAmount: BigInt(q.sellAmount), feeAmount: BigInt(q.feeAmount), buyAmount: BigInt(q.buyAmount) },
        buyAmount: c.quote.minAmountOut,
        validTo: Math.floor(c.quote.validUntil.getTime() / 1000),
      });
      const uid = orderUid(c.chainId, cowFor(c.chainId).settlement, order, c.holder);
      await postPreSignOrder({ chainId: c.chainId, order, owner: c.holder, appDataDoc: APP_DATA_DOC, uid });
      const data: ApiData = { order: orderToJson(order) };
      return { kind: "api", ref: uid, data };
    },

    poll: async (c): Promise<PollResult> => {
      const { uid, order } = postedOrder(c);
      const view = await getOrder(c.chainId, uid);
      if (!view) return { status: "failed", reason: "order unknown to the orderbook" };
      if (view.status === "expired" || view.status === "cancelled") return { status: "expired" };
      if (view.invalidated) return { status: "failed", reason: "order invalidated" };
      if (view.status !== "fulfilled") {
        // The orderbook marks expiry itself; past validTo with a long grace,
        // treat a still-open order as expired so the row does not poll forever.
        if (c.now.getTime() / 1000 > view.validTo + 6 * 3600) return { status: "expired" };
        return { status: "pending" };
      }
      const trades = (await getTrades(c.chainId, uid)).filter(
        (t) => t.orderUid.toLowerCase() === uid.toLowerCase(),
      );
      if (trades.length === 0) return { status: "pending" }; // indexer lag
      // Fill-or-kill: one trade. Read what the chain says it received.
      const trade = trades[trades.length - 1];
      const settled = await readSettledTrade({ chainId: c.chainId, txHash: trade.txHash, orderUid: uid });
      if (!settled) {
        return { status: "failed", reason: `no Trade event for the order in ${trade.txHash}` };
      }
      const min = orderFromJson(order).buyAmount;
      if (settled.buyAmount < min) {
        return {
          status: "failed",
          reason: `settled ${settled.buyAmount} is below the order minimum ${min}`,
        };
      }
      if (settled.buyAmount !== trade.buyAmount) {
        console.warn("[convert] orderbook / chain fill differ", uid, trade.buyAmount, settled.buyAmount);
      }
      return {
        status: "filled",
        result: { kind: "wait", amountOut: settled.buyAmount.toString(), txHash: trade.txHash },
      };
    },
  };
}

export { getAddress as _checksum };
