// SPDX-License-Identifier: AGPL-3.0-or-later

// CoW Protocol order math. Pure, unit-tested against a settled Gnosis order
// (cow-order.test.ts). Module map: services/convert/assets.ts.
//
// An order is identified by its uid = orderDigest ‖ owner ‖ validTo, where
// the digest is the EIP-712 hash of the Order struct under the settlement
// contract's domain ("Gnosis Protocol" v2). We compute it locally, so posting
// the same order twice is detectable and the pre-sign calldata can be built
// before the orderbook answers.
//
// Pre-sign orders (signingScheme "presign") carry no signature: the owner
// (our Safe) calls `GPv2Settlement.setPreSignature(uid, true)`, which the
// solvers read on chain. The orderbook skips the balance / allowance check
// for them, so the order is posted first and the batch that approves and
// pre-signs (and, for BREAD → EURe, burns and wraps) runs after.

import {
  encodeFunctionData,
  encodePacked,
  getAddress,
  hashTypedData,
  hexToNumber,
  keccak256,
  size,
  slice,
  stringToHex,
} from "viem";

import type { Address, Hex } from "./types";

// Field order is load-bearing (GPv2Order.TYPE_HASH).
export const COW_ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;

export type CowOrder = {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: bigint;
  buyAmount: bigint; // for a sell order: the minimum to receive
  validTo: number; // unix seconds
  appData: Hex; // bytes32: keccak256 of the appData document
  feeAmount: bigint; // always 0: the orderbook refuses signed fees (NonZeroFee)
  kind: "sell" | "buy";
  partiallyFillable: boolean;
  sellTokenBalance: "erc20";
  buyTokenBalance: "erc20";
};

export function cowDomain(chainId: number, settlement: Address) {
  return {
    name: "Gnosis Protocol",
    version: "v2",
    chainId,
    verifyingContract: getAddress(settlement),
  };
}

export function orderDigest(chainId: number, settlement: Address, order: CowOrder): Hex {
  return hashTypedData({
    domain: cowDomain(chainId, settlement),
    types: COW_ORDER_TYPES,
    primaryType: "Order",
    message: {
      ...order,
      sellToken: getAddress(order.sellToken),
      buyToken: getAddress(order.buyToken),
      receiver: getAddress(order.receiver),
    },
  });
}

export const ORDER_UID_BYTES = 56;

export function orderUid(
  chainId: number,
  settlement: Address,
  order: CowOrder,
  owner: Address,
): Hex {
  return encodePacked(
    ["bytes32", "address", "uint32"],
    [orderDigest(chainId, settlement, order), getAddress(owner), order.validTo],
  );
}

export function parseOrderUid(uid: Hex): { digest: Hex; owner: Address; validTo: number } {
  if (size(uid) !== ORDER_UID_BYTES) throw new Error(`Order uid is not ${ORDER_UID_BYTES} bytes`);
  return {
    digest: slice(uid, 0, 32),
    owner: getAddress(slice(uid, 32, 52)),
    validTo: hexToNumber(slice(uid, 52, 56)),
  };
}

// ---------------------------------------------------------------------------
// appData
// ---------------------------------------------------------------------------

// The document the orderbook stores with the order (cowprotocol/app-data
// schema v1.3.0: appCode + metadata required). Its keccak256 is the order's
// `appData` field. Kept minimal and fixed so the hash never drifts.
export const APP_DATA_DOC = JSON.stringify({
  appCode: "La Caisse",
  metadata: {},
  version: "1.3.0",
});

export function appDataHash(doc: string): Hex {
  return keccak256(stringToHex(doc));
}

export const APP_DATA_HASH: Hex = appDataHash(APP_DATA_DOC);

// ---------------------------------------------------------------------------
// Building an order from a quote
// ---------------------------------------------------------------------------

export const BPS = BigInt(10_000);

/** `amount` reduced by `bps` basis points (rounded down). */
export function applySlippage(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error(`Bad slippage ${bps}`);
  return (amount * (BPS - BigInt(bps))) / BPS;
}

/**
 * A fee-less sell order from an orderbook quote: the whole input is sold
 * (`sellAmount + feeAmount` of the quote — the fee is paid inside the
 * price), and at least `buyAmount` is received. Not partially fillable: one
 * fill or nothing, so the amount that lands is the amount the next leg sees.
 */
export function orderFromQuote(a: {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  quote: { sellAmount: bigint; feeAmount: bigint; buyAmount: bigint };
  buyAmount: bigint; // the minimum to enforce (slippage already applied)
  validTo: number;
  appData?: Hex;
}): CowOrder {
  return {
    sellToken: getAddress(a.sellToken),
    buyToken: getAddress(a.buyToken),
    receiver: getAddress(a.receiver),
    sellAmount: a.quote.sellAmount + a.quote.feeAmount,
    buyAmount: a.buyAmount,
    validTo: a.validTo,
    appData: a.appData ?? APP_DATA_HASH,
    feeAmount: BigInt(0),
    kind: "sell",
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };
}

// JSON form stored on the conversion row.
export type JsonCowOrder = Omit<CowOrder, "sellAmount" | "buyAmount" | "feeAmount"> & {
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
};

export function orderToJson(o: CowOrder): JsonCowOrder {
  return {
    ...o,
    sellAmount: o.sellAmount.toString(),
    buyAmount: o.buyAmount.toString(),
    feeAmount: o.feeAmount.toString(),
  };
}

export function orderFromJson(j: JsonCowOrder): CowOrder {
  return {
    ...j,
    sellAmount: BigInt(j.sellAmount),
    buyAmount: BigInt(j.buyAmount),
    feeAmount: BigInt(j.feeAmount),
  };
}

// ---------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------

export const GPV2_SETTLEMENT_ABI = [
  {
    type: "function",
    name: "setPreSignature",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderUid", type: "bytes" },
      { name: "signed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Trade",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "sellToken", type: "address", indexed: false },
      { name: "buyToken", type: "address", indexed: false },
      { name: "sellAmount", type: "uint256", indexed: false },
      { name: "buyAmount", type: "uint256", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false },
      { name: "orderUid", type: "bytes", indexed: false },
    ],
  },
] as const;

export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function setPreSignatureData(uid: Hex, signed = true): Hex {
  return encodeFunctionData({
    abi: GPV2_SETTLEMENT_ABI,
    functionName: "setPreSignature",
    args: [uid, signed],
  });
}

export function erc20ApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [getAddress(spender), amount],
  });
}
