// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { decodeEventLog, getAddress } from "viem";

import { publicClientFor } from "@/services/safe/relayer";

import { COW_CONTRACTS_BY_CHAIN } from "./assets";
import { ERC20_APPROVE_ABI, GPV2_SETTLEMENT_ABI } from "./cow-order";
import { ConvertError, type Address, type Hex } from "./types";

// The chain reads the converters need, through the relayer's RPC client
// (services/safe/relayer.ts). Module map: services/convert/assets.ts.

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

export type SettledTrade = { sellAmount: bigint; buyAmount: bigint; feeAmount: bigint };

/**
 * The settlement contract's `Trade` event for `orderUid` in the mined
 * transaction `txHash` — what the chain says the order received, as opposed
 * to what the orderbook reports. Null when the receipt has no such trade.
 */
export async function readSettledTrade(a: {
  chainId: number;
  txHash: Hex;
  orderUid: Hex;
}): Promise<SettledTrade | null> {
  const cow = COW_CONTRACTS_BY_CHAIN[a.chainId];
  if (!cow) throw new ConvertError("config", `CoW is not configured for chain ${a.chainId}`);
  const receipt = await publicClientFor(a.chainId).getTransactionReceipt({ hash: a.txHash });
  if (receipt.status !== "success") return null;
  const settlement = cow.settlement.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== settlement) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: GPV2_SETTLEMENT_ABI, data: log.data, topics: log.topics });
    } catch {
      continue; // another settlement event (Settlement, Interaction…)
    }
    if (decoded.eventName !== "Trade") continue;
    if (decoded.args.orderUid.toLowerCase() !== a.orderUid.toLowerCase()) continue;
    return {
      sellAmount: decoded.args.sellAmount,
      buyAmount: decoded.args.buyAmount,
      feeAmount: decoded.args.feeAmount,
    };
  }
  return null;
}
