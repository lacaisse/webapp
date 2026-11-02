// SPDX-License-Identifier: AGPL-3.0-or-later

// BREAD legs. BREAD (Breadchain, Gnosis) is a 1:1 wrapper of native xDAI
// parked in sDAI: `mint(receiver)` takes native xDAI with the call and mints
// the same amount of BREAD; `burn(amount, receiver)` burns and pays native
// xDAI back. The legs trade WXDAI, not native xDAI, because the swap leg
// (CoW) can only buy / sell ERC-20s for a smart-contract holder; the wrap /
// unwrap is part of the batch. Both legs are `exact` (output = input), so the
// walk folds their calls into the neighbouring swap's batch.
// Pure: no server-only, no fetch, no DB.

import { encodeFunctionData } from "viem";

import { BREAD_CONTRACTS_BY_CHAIN, GNOSIS_ASSETS } from "../assets";
import { ConvertError, type Address, type Leg, type LegContext, type Step } from "../types";

const BREAD_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "burn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [],
  },
] as const;

const WXDAI_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

function contractsFor(chainId: number) {
  const c = BREAD_CONTRACTS_BY_CHAIN[chainId];
  if (!c) throw new ConvertError("config", `BREAD is not configured for chain ${chainId}`);
  return c;
}

export function breadMintData(receiver: Address) {
  return encodeFunctionData({ abi: BREAD_ABI, functionName: "mint", args: [receiver] });
}

export function breadBurnData(amount: bigint, receiver: Address) {
  return encodeFunctionData({ abi: BREAD_ABI, functionName: "burn", args: [amount, receiver] });
}

export function wxdaiDepositData() {
  return encodeFunctionData({ abi: WXDAI_ABI, functionName: "deposit" });
}

export function wxdaiWithdrawData(amount: bigint) {
  return encodeFunctionData({ abi: WXDAI_ABI, functionName: "withdraw", args: [amount] });
}

// An exact leg's whole life is one `calls` step.
const exactLeg = (
  a: Pick<Leg, "id" | "from" | "to">,
  calls: (c: LegContext) => Step,
): Leg => ({
  ...a,
  exact: true,
  contracts: (chainId) => {
    const c = contractsFor(chainId);
    return [c.wxdai, c.bread];
  },
  quote: async (r) => {
    if (r.amountIn <= BigInt(0)) throw new ConvertError("amount", "Amount must be positive");
    contractsFor(r.chainId);
    return {
      amountIn: r.amountIn,
      amountOut: r.amountIn,
      minAmountOut: r.amountIn,
      validUntil: new Date(r.now.getTime() + r.validFor * 1000),
    };
  },
  next: (c) => (c.results.some((r) => r.kind === "calls") ? null : calls(c)),
  output: (c) => (c.results.some((r) => r.kind === "calls") ? c.amountIn : null),
});

/** WXDAI → BREAD: unwrap, then mint with the native xDAI (1:1). */
export const breadMint: Leg = exactLeg(
  { id: "bread-mint", from: GNOSIS_ASSETS.WXDAI, to: GNOSIS_ASSETS.BREAD },
  (c) => {
    const { wxdai, bread } = contractsFor(c.chainId);
    return {
      kind: "calls",
      label: "mint",
      calls: [
        { to: wxdai, value: BigInt(0), data: wxdaiWithdrawData(c.amountIn), label: "unwrap" },
        { to: bread, value: c.amountIn, data: breadMintData(c.holder), label: "mint" },
      ],
    };
  },
);

/** BREAD → WXDAI: burn for native xDAI, then wrap it (1:1). */
export const breadBurn: Leg = exactLeg(
  { id: "bread-burn", from: GNOSIS_ASSETS.BREAD, to: GNOSIS_ASSETS.WXDAI },
  (c) => {
    const { wxdai, bread } = contractsFor(c.chainId);
    return {
      kind: "calls",
      label: "burn",
      calls: [
        { to: bread, value: BigInt(0), data: breadBurnData(c.amountIn, c.holder), label: "burn" },
        { to: wxdai, value: c.amountIn, data: wxdaiDepositData(), label: "wrap" },
      ],
    };
  },
);
