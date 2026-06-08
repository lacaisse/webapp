// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { createPublicClient, http, isAddress, type Address } from "viem";
import { gnosis } from "viem/chains";

// Counterfactual derivation of a fund's smart-account address against
// CitizenPay's Safe Account factory. We call the view function
// `getAddress(_owner, _nonce)` — see app/abi/SafeAccountFactory.abi.json.
//
// Salt nonce defaults to 0: the minter's own Safe (one per fund, never
// re-used). Named fund accounts (services/token-account/*) pass salts ≥ 1 to
// derive additional Safes from the same EOA. The factory is selected by
// CitizenPay per treasury (returned from `GET /v2/treasury` and cached on
// `Fund.citizenPayAccountFactoryAddress`) — same factory deployment on
// every supported chain (CREATE2 with deterministic deployer), so the
// derived smart-account address is identical regardless of the token
// chain. We RPC against Gnosis (chain id 100) for convenience.

const DEFAULT_SALT_NONCE = BigInt(0);

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
  // A plain eth_call against the Safe factory — route it through the
  // CitizenPay bundler (a full JSON-RPC node), not Alchemy (which we reserve
  // for the enhanced balance/transfer APIs). Gnosis (chain 100): CREATE2 makes
  // the derived address identical on every chain, so one chain's read suffices.
  const bundler = process.env.CITIZENPAY_BUNDLER_URL;
  if (!bundler) return null;
  return `${bundler.replace(/\/$/, "")}/v1/100/rpc`;
}

/**
 * Counterfactually derive the smart-account address for `eoaAddress` against
 * `factoryAddress` (the CP-provided factory cached on
 * `Fund.citizenPayAccountFactoryAddress`).
 *
 * `saltNonce` defaults to 0 (the minter's Safe); pass ≥ 1 for additional
 * named fund accounts derived from the same EOA.
 *
 * Best-effort: returns null when env is incomplete (no Alchemy key), the
 * factory address is missing/invalid, or the RPC call fails. Callers should
 * persist the EOA and leave `tokenMinterSmartAccountAddress` null when this
 * returns null — a later sync / admin action can fill it in.
 */
export async function deriveSmartAccountAddress(args: {
  eoaAddress: string;
  factoryAddress: string;
  saltNonce?: bigint;
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
      args: [args.eoaAddress as Address, args.saltNonce ?? DEFAULT_SALT_NONCE],
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
