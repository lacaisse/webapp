// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import {
  arbitrum,
  base,
  gnosis,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";

import { alchemyNetwork } from "@/services/alchemy/client";

// Read-only on-chain role lookups against an OpenZeppelin AccessControl
// ERC20 (mint, burnFrom, transfer, role helpers — see app/abi/ERC20.abi.json).
// Used by the Token settings tab to surface "does this fund's smart
// account actually have permission to mint?" without sending a userop.

const CHAIN_BY_ID: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  100: gnosis,
  137: polygon,
  8453: base,
  42161: arbitrum,
};

// `keccak256("MINTER_ROLE")` — OpenZeppelin AccessControl's standard role
// identifier, hardcoded so we skip the contract round-trip. Verified
// matches the on-chain constant for every OZ-derived ERC20 — if a token
// ever uses a non-standard role hash, swap back to reading
// `MINTER_ROLE()` from the contract.
const MINTER_ROLE: Hex =
  "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";

const ERC20_HAS_ROLE_ABI = [
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export type RoleStatus = "has-role" | "missing-role" | "unknown";

/**
 * Check whether `account` holds `MINTER_ROLE` on the ERC20 at
 * `tokenAddress`. Returns "unknown" on any RPC or config failure so
 * call sites can render a neutral state rather than failing the page.
 */
export async function checkMinterRole(args: {
  tokenAddress: string;
  chainId: number;
  account: string;
}): Promise<RoleStatus> {
  if (!isAddress(args.tokenAddress) || !isAddress(args.account)) return "unknown";
  const chain = CHAIN_BY_ID[args.chainId];
  const network = alchemyNetwork(args.chainId);
  const key = process.env.ALCHEMY_API_KEY;
  if (!chain || !network || !key) return "unknown";

  try {
    const client = createPublicClient({
      chain,
      transport: http(`https://${network}.g.alchemy.com/v2/${key}`),
    });
    const has = (await client.readContract({
      address: args.tokenAddress as Address,
      abi: ERC20_HAS_ROLE_ABI,
      functionName: "hasRole",
      args: [MINTER_ROLE, args.account as Address],
    })) as boolean;
    return has ? "has-role" : "missing-role";
  } catch (e) {
    console.warn("[token/permissions] checkMinterRole failed", e);
    return "unknown";
  }
}
