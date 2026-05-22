// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { createPublicClient, http, isAddress, type Address } from "viem";
import { gnosis } from "viem/chains";

// Counterfactual derivation of a fund's smart-account address against
// CitizenPay's Safe Account factory. We call the view function
// `getAddress(_owner, _nonce)` — see app/abi/SafeAccountFactory.abi.json.
//
// Salt nonce is hard-coded to 0: one minter EOA per fund, one Safe per
// minter, never re-used. The factory is selected by CitizenPay per
// treasury (returned from `GET /v2/treasury` and cached on
// `Fund.citizenPayAccountFactoryAddress`) — same factory deployment on
// every supported chain (CREATE2 with deterministic deployer), so the
// derived smart-account address is identical regardless of the token
// chain. We RPC against Gnosis (chain id 100) for convenience.

const SALT_NONCE = BigInt(0);

const FACTORY_ABI = [
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

function getRpcUrl(): string | null {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) return null;
  return `https://gnosis-mainnet.g.alchemy.com/v2/${key}`;
}

/**
 * Counterfactually derive the smart-account address for `eoaAddress` against
 * `factoryAddress` (the CP-provided factory cached on
 * `Fund.citizenPayAccountFactoryAddress`).
 *
 * Best-effort: returns null when env is incomplete (no Alchemy key), the
 * factory address is missing/invalid, or the RPC call fails. Callers should
 * persist the EOA and leave `tokenMinterSmartAccountAddress` null when this
 * returns null — a later sync / admin action can fill it in.
 */
export async function deriveSmartAccountAddress(args: {
  eoaAddress: string;
  factoryAddress: string;
}): Promise<string | null> {
  if (!isAddress(args.eoaAddress)) return null;
  if (!isAddress(args.factoryAddress)) return null;

  const rpcUrl = getRpcUrl();
  if (!rpcUrl) return null;

  try {
    const client = createPublicClient({
      chain: gnosis,
      transport: http(rpcUrl),
    });
    const address = await client.readContract({
      address: args.factoryAddress as Address,
      abi: FACTORY_ABI,
      functionName: "getAddress",
      args: [args.eoaAddress as Address, SALT_NONCE],
    });
    return address;
  } catch (e) {
    console.warn(
      "[token/smart-account] getAddress() failed; smart-account address left null",
      e,
    );
    return null;
  }
}
