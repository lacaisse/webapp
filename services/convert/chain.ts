// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAbiItem, getAddress } from "viem";

import { publicClientFor } from "@/services/safe/relayer";

import { COW_CONTRACTS_BY_CHAIN } from "./assets";
import { ERC20_APPROVE_ABI, GPV2_SETTLEMENT_ABI } from "./cow-order";
import { ConvertError, type Address, type Hex } from "./types";

// The chain reads the converters need, through the relayer's RPC client
// (services/safe/relayer.ts). A fill is read from the chain, never from the
// orderbook: the orderbook rate-limits reads per IP (and this app's server
// shares its IP with every other tenant of its host), and its index lags
// the chain anyway. Module map: services/convert/assets.ts.

/** ERC-20 balance of `holder`, or the native balance when `token` is null. */
export async function holderBalance(a: {
  chainId: number;
  holder: Address;
  token: Address | null;
}): Promise<bigint> {
  const client = publicClientFor(a.chainId);
  if (!a.token) return client.getBalance({ address: getAddress(a.holder) });
  return client.readContract({
    address: getAddress(a.token),
    abi: ERC20_APPROVE_ABI,
    functionName: "balanceOf",
    args: [getAddress(a.holder)],
  });
}

function settlementFor(chainId: number): Address {
  const cow = COW_CONTRACTS_BY_CHAIN[chainId];
  if (!cow) throw new ConvertError("config", `CoW is not configured for chain ${chainId}`);
  return getAddress(cow.settlement);
}

// GPv2Settlement.filledAmount: how much of the order's sell amount has been
// taken; every bit set once the owner invalidated the order.
export const ORDER_INVALIDATED: bigint = BigInt(2) ** BigInt(256) - BigInt(1);

export async function orderFilledAmount(a: { chainId: number; orderUid: Hex }): Promise<bigint> {
  return publicClientFor(a.chainId).readContract({
    address: settlementFor(a.chainId),
    abi: GPV2_SETTLEMENT_ABI,
    functionName: "filledAmount",
    args: [a.orderUid],
  });
}

/** The block a mined transaction sits in; null when the RPC has no receipt for it. */
export async function blockOfTransaction(a: { chainId: number; txHash: Hex }): Promise<bigint | null> {
  try {
    return (await publicClientFor(a.chainId).getTransactionReceipt({ hash: a.txHash })).blockNumber;
  } catch {
    return null;
  }
}

export type SettledTrade = { sellAmount: bigint; buyAmount: bigint; feeAmount: bigint };
export type FoundTrade = SettledTrade & { txHash: Hex; blockNumber: bigint };

const TRADE_EVENT = getAbiItem({ abi: GPV2_SETTLEMENT_ABI, name: "Trade" });
// Blocks per eth_getLogs: what Alchemy answers without a size cap.
const LOG_CHUNK = BigInt(2_000);
// An order lives a week (engine.ts ORDER_VALID_FOR_S); with the pre-signature's
// block unknown, a fill is at most this far back (Gnosis: 5 s blocks).
const MAX_LOOKBACK_BLOCKS = BigInt((8 * 24 * 3600) / 5);

/**
 * The settlement contract's `Trade` event for `orderUid` — what the chain
 * says the order sold and received, and the transaction it settled in.
 * Trades are indexed by owner, so the scan reads only this holder's, from
 * `fromBlock` (the pre-signature's block; a fill cannot precede it) up to
 * the latest, in chunks. Null when no such trade is in range yet.
 */
export async function findSettledTrade(a: {
  chainId: number;
  owner: Address;
  orderUid: Hex;
  fromBlock: bigint | null;
}): Promise<FoundTrade | null> {
  const client = publicClientFor(a.chainId);
  const settlement = settlementFor(a.chainId);
  const latest = await client.getBlockNumber();
  const floor = latest > MAX_LOOKBACK_BLOCKS ? latest - MAX_LOOKBACK_BLOCKS : BigInt(0);
  const want = a.orderUid.toLowerCase();
  for (let from = a.fromBlock ?? floor; from <= latest; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - BigInt(1) < latest ? from + LOG_CHUNK - BigInt(1) : latest;
    const logs = await client.getLogs({
      address: settlement,
      event: TRADE_EVENT,
      args: { owner: getAddress(a.owner) },
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    for (const log of logs) {
      if (log.args.orderUid.toLowerCase() !== want) continue;
      return {
        sellAmount: log.args.sellAmount,
        buyAmount: log.args.buyAmount,
        feeAmount: log.args.feeAmount,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      };
    }
  }
  return null;
}
