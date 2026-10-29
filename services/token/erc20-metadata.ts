// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import {
  decodeAbiParameters,
  getAddress,
  hexToString,
  type Address,
  type Hex,
} from "viem";

import { alchemyNetwork, alchemyRpc } from "@/services/alchemy/client";

// Reads an ERC-20's identity (symbol / name / decimals) from its contract over
// Alchemy RPC, for registering a custom display token (Settings → Token →
// Custom tokens). `decimals()` is the ERC-20 test: no code at the address, or
// a call that reverts / returns garbage, means "not an ERC-20". `symbol()` /
// `name()` accept the legacy bytes32 encoding (MKR-style tokens); a missing
// name falls back to the symbol, a missing symbol refuses the token.

export type Erc20Metadata = {
  address: Address; // checksummed
  symbol: string;
  name: string;
  decimals: number;
};

export class Erc20MetadataError extends Error {
  readonly code: "not_erc20" | "unsupported_chain";
  constructor(code: Erc20MetadataError["code"], message: string) {
    super(message);
    this.name = "Erc20MetadataError";
    this.code = code;
  }
}

// 4-byte selectors.
const DECIMALS = "0x313ce567";
const SYMBOL = "0x95d89b41";
const NAME = "0x06fdde03";

const MAX_SYMBOL = 32;
const MAX_NAME = 100;

export async function readErc20Metadata(
  chainId: number,
  rawAddress: string,
): Promise<Erc20Metadata> {
  const network = alchemyNetwork(chainId);
  if (!network) throw new Erc20MetadataError("unsupported_chain", `No RPC for chain ${chainId}`);
  const address = getAddress(rawAddress);

  const code = await alchemyRpc<Hex>(network, "eth_getCode", [address, "latest"]);
  if (!code || code === "0x") throw new Erc20MetadataError("not_erc20", "No contract at address");

  const [decimalsRaw, symbolRaw, nameRaw] = await Promise.all([
    call(network, address, DECIMALS),
    call(network, address, SYMBOL),
    call(network, address, NAME),
  ]);

  const decimals = decodeDecimals(decimalsRaw);
  if (decimals == null) throw new Erc20MetadataError("not_erc20", "decimals() failed");
  const symbol = decodeText(symbolRaw, MAX_SYMBOL);
  if (!symbol) throw new Erc20MetadataError("not_erc20", "symbol() failed");
  const name = decodeText(nameRaw, MAX_NAME) || symbol;

  return { address, symbol, name, decimals };
}

// eth_call → raw return data, or null when the call reverted (JSON-RPC error
// from the node). Transport failures (HTTP, no result) still throw: they say
// nothing about the contract, so the caller must not read them as "not an
// ERC-20".
async function call(network: string, to: Address, data: Hex): Promise<Hex | null> {
  try {
    return await alchemyRpc<Hex>(network, "eth_call", [{ to, data }, "latest"]);
  } catch (e) {
    // services/alchemy/client.ts reports a JSON-RPC `error` field as
    // "Alchemy <method> error: …" (reverts land here).
    if (e instanceof Error && e.message.startsWith("Alchemy eth_call error:")) return null;
    throw e;
  }
}

function decodeDecimals(data: Hex | null): number | null {
  if (!data || data.length !== 66) return null; // exactly one 32-byte word
  try {
    const [value] = decodeAbiParameters([{ type: "uint256" }], data);
    return value <= BigInt(255) ? Number(value) : null; // uint8 by the standard
  } catch {
    return null;
  }
}

// ABI `string`, or a legacy `bytes32` (one word, zero-padded on the right).
function decodeText(data: Hex | null, max: number): string | null {
  if (!data || data === "0x") return null;
  let text: string | null = null;
  try {
    [text] = decodeAbiParameters([{ type: "string" }], data);
  } catch {
    if (data.length === 66) {
      try {
        text = hexToString(data, { size: 32 });
      } catch {
        text = null;
      }
    }
  }
  if (text == null) return null;
  // Drop NUL padding and control characters; keep it to one short line.
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean ? clean.slice(0, max) : null;
}
