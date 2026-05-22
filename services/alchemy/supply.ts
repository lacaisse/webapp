// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";
import { alchemyNetwork, alchemyRpc } from "./client";

// Read the standard ERC-20 `totalSupply()` view via `eth_call`. The
// 4-byte function selector is `keccak256("totalSupply()")[:4]` = 0x18160ddd
// — a constant for every conformant ERC-20, so we don't need an ABI.
//
// Returned as a hex-encoded uint256; the caller formats with the token's
// decimals (we cache those on Fund).

const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

export const getTotalSupply = cache(
  async (chainId: number, contractAddress: string): Promise<string> => {
    const network = alchemyNetwork(chainId);
    if (!network) {
      throw new Error(`Alchemy: unsupported chain id ${chainId}`);
    }
    return alchemyRpc<string>(network, "eth_call", [
      { to: contractAddress.toLowerCase(), data: TOTAL_SUPPLY_SELECTOR },
      "latest",
    ]);
  },
);
