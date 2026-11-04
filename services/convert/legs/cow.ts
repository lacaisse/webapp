// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { COW_CONTRACTS_BY_CHAIN, assetAddress, assetChainId } from "../assets";
import { ORDER_INVALIDATED, blockOfTransaction, findSettledTrade, orderFilledAmount } from "../chain";
import { postPreSignOrder, preparedOrderRequest, preparedQuoteRequest, requestQuote } from "../cow-api";
import {
  APP_DATA_DOC,
  APP_DATA_HASH,
  ERC20_APPROVE_SELECTOR,
  SET_PRE_SIGNATURE_SELECTOR,
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
  type QuoteRequest,
  type RelayedHttp,
  type StepResult,
} from "../types";

// The CoW swap leg: any ERC-20 → ERC-20 on a chain CoW serves, as a fee-less,
// fill-or-kill pre-sign order owned by the holder. Three steps:
//   api   — post the order (uid computed locally; a duplicate is ours)
//   calls — approve the exact sell amount to the vault relayer, then
//           setPreSignature(uid, true) on the settlement contract
//   wait  — the chain reports the fill: the settlement contract's
//           filledAmount, then its Trade event for the amount that arrived.
//           The orderbook is not asked (chain.ts says why).
// Server-only: quote / run / poll call the orderbook and the chain. Module
// map: services/convert/assets.ts.

// Seconds past an order's validTo before an unfilled order is given up on.
const EXPIRY_GRACE_S = 10 * 60;

type QuoteData = { sellAmount: string; feeAmount: string; buyAmount: string; quoteId: number | null };
type ApiData = { order: JsonCowOrder };
// What the api step keeps between its request and its answer (sealed into
// the start ticket when the browser makes the post, engine.ts).
type ApiPending = { uid: Hex; order: JsonCowOrder };

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

  // The one quote request, whether the server or the holder's browser makes it.
  const cowQuoteRequest = (r: QuoteRequest) => {
    if (r.chainId !== chainId) throw new ConvertError("config", "CoW leg: wrong chain");
    if (r.amountIn <= BigInt(0)) throw new ConvertError("amount", "Amount must be positive");
    return {
      sellToken,
      buyToken,
      owner: r.holder,
      sellAmountBeforeFee: r.amountIn,
      appDataDoc: APP_DATA_DOC,
      appDataHash: APP_DATA_HASH,
      validFor: r.validFor,
    };
  };

  // The order the api step posts: the quote's amounts, the minimum the
  // conversion accepted, the quote's validity.
  const orderFor = (c: LegContext) => {
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
    return { order, uid };
  };

  // The api step's result: the order is on the orderbook — posted by the
  // browser (`answer`) or by the server (null). The pending order is hashed
  // again rather than trusted: its uid is what the Safe will pre-sign.
  const postOrder = async (c: LegContext, pending: unknown, answer: RelayedHttp | null): Promise<StepResult> => {
    const p = pending as Partial<ApiPending> | undefined;
    if (!p || typeof p.uid !== "string" || !p.order) {
      throw new ConvertError("invalid_state", "CoW api step has no pending order");
    }
    const order = orderFromJson(p.order);
    const uid = orderUid(c.chainId, cowFor(c.chainId).settlement, order, c.holder);
    if (uid.toLowerCase() !== p.uid.toLowerCase()) {
      throw new ConvertError("invalid_state", "CoW pending order does not hash to its uid");
    }
    await postPreSignOrder({ chainId: c.chainId, order, owner: c.holder, appDataDoc: APP_DATA_DOC, uid }, answer);
    const data: ApiData = { order: p.order };
    return { kind: "api", ref: uid, data };
  };

  return {
    id: "cow-swap",
    from,
    to,
    exact: false,
    steps: ["api", "calls", "wait"],
    contracts: (c) => [
      { address: sellToken, selectors: [ERC20_APPROVE_SELECTOR] },
      { address: cowFor(c).settlement, selectors: [SET_PRE_SIGNATURE_SELECTOR] },
    ],

    quoteRequest: (r) => preparedQuoteRequest(r.chainId, cowQuoteRequest(r)),

    quote: async (r) => {
      const q = await requestQuote(r.chainId, cowQuoteRequest(r), { relayed: r.relayed, now: r.now });
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
        fee: q.feeAmount, // the network fee, in the sell token, paid inside the price
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

    apiRequest: (c) => {
      const { order, uid } = orderFor(c);
      const pending: ApiPending = { uid, order: orderToJson(order) };
      return {
        request: preparedOrderRequest({ chainId: c.chainId, order, owner: c.holder, appDataDoc: APP_DATA_DOC }),
        pending,
      };
    },

    apiResult: (c, pending, answer) => postOrder(c, pending, answer),

    run: (c): Promise<StepResult> => {
      const { order, uid } = orderFor(c);
      return postOrder(c, { uid, order: orderToJson(order) } satisfies ApiPending, null);
    },

    poll: async (c): Promise<PollResult> => {
      const { uid, order } = postedOrder(c);
      const o = orderFromJson(order);
      const filled = await orderFilledAmount({ chainId: c.chainId, orderUid: uid });
      if (filled === ORDER_INVALIDATED) return { status: "failed", reason: "order invalidated on chain" };
      if (filled === BigInt(0)) {
        // Nothing yet. The contract refuses to settle past validTo; a short
        // grace covers a settlement mined right at it.
        if (c.now.getTime() / 1000 > o.validTo + EXPIRY_GRACE_S) return { status: "expired" };
        return { status: "pending" };
      }
      // Filled (fill-or-kill: in one go). Its Trade event sits at or after
      // the block the pre-signature landed in.
      const presign = c.results.find((r) => r.kind === "calls");
      const fromBlock = presign?.txHash
        ? await blockOfTransaction({ chainId: c.chainId, txHash: presign.txHash as Hex })
        : null;
      const trade = await findSettledTrade({ chainId: c.chainId, owner: c.holder, orderUid: uid, fromBlock });
      if (!trade) return { status: "pending" }; // the RPC's logs trail its state: next poll
      if (trade.buyAmount < o.buyAmount) {
        return {
          status: "failed",
          reason: `settled ${trade.buyAmount} is below the order minimum ${o.buyAmount}`,
        };
      }
      return {
        status: "filled",
        result: { kind: "wait", amountOut: trade.buyAmount.toString(), txHash: trade.txHash },
      };
    },
  };
}
