// SPDX-License-Identifier: AGPL-3.0-or-later

// Token converters — assets and the contracts the legs call. Pure: no
// server-only, no DB, no fetch, so the UI can import ids and labels too.
//
// Module map (services/convert/*):
//   types.ts        — Leg / Converter / Step contracts, stored-state JSON.
//   assets.ts       — this file: CAIP-19 asset ids, per-chain contract
//                     addresses (CoW, BREAD, WXDAI), display-token mapping.
//   cow-order.ts    — pure: CoW order struct, EIP-712 digest, order uid,
//                     appData, approve / setPreSignature calldata.
//   legs/bread.ts   — pure: WXDAI → BREAD (mint), BREAD → WXDAI (burn).
//   legs/cow.ts     — server: any ERC-20 → ERC-20 through a CoW pre-sign
//                     order (quote, post, approve + presign batch, fill).
//   walk.ts         — pure: the position of a conversion in its legs, with
//                     the fold of exact legs into the next batch; chained
//                     quotes.
//   registry.ts     — server: the converters, pair lookup, what a fund
//                     is offered.
//   cow-api.ts      — server: CoW orderbook HTTP client (no SDK).
//   browser-relay.ts — client: the orderbook requests the server prepared
//                     (quote, order post), made from the holder's browser
//                     (its own IP, not the server's shared one).
//   engine.ts       — server: quote / start / continue / cancel — the parts
//                     that create Safe proposals.
//   progress.ts     — server: what happens when a proposal executes or
//                     disappears, polling fills (cron), status moves.
//   schemas.ts      — Zod schemas shared by forms and actions.
//   admin-actions.ts — "use server" actions behind the Safe pages.

import { getAddress } from "viem";

import type { ExtraToken } from "@/services/token/extra-tokens";

import type { Address, AssetId, Erc20AssetId, NativeAssetId } from "./types";

export const GNOSIS_CHAIN_ID = 100;

// SLIP-44 coin type of the chain's native coin (xDAI on Gnosis).
const NATIVE_SLIP44_BY_CHAIN: Record<number, number> = { [GNOSIS_CHAIN_ID]: 700 };

export function erc20Asset(chainId: number, address: string): Erc20AssetId {
  return `eip155:${chainId}/erc20:${getAddress(address).toLowerCase() as `0x${string}`}`;
}

export function nativeAsset(chainId: number): NativeAssetId {
  const slip44 = NATIVE_SLIP44_BY_CHAIN[chainId];
  if (slip44 === undefined) throw new Error(`No native asset registered for chain ${chainId}`);
  return `eip155:${chainId}/slip44:${slip44}`;
}

export function assetChainId(asset: AssetId): number {
  return Number(asset.slice("eip155:".length, asset.indexOf("/")));
}

/** The ERC-20 contract of an asset (checksummed), null for a native coin. */
export function assetAddress(asset: AssetId): Address | null {
  const i = asset.indexOf("/erc20:");
  return i === -1 ? null : getAddress(asset.slice(i + "/erc20:".length));
}

export function isAssetId(s: string): s is AssetId {
  return /^eip155:\d+\/(erc20:0x[0-9a-f]{40}|slip44:\d+)$/.test(s);
}

/** The asset a fund display token (services/token/extra-tokens.ts) stands for. */
export function displayTokenAsset(tok: Pick<ExtraToken, "address">, chainId: number): AssetId {
  return tok.address ? erc20Asset(chainId, tok.address) : nativeAsset(chainId);
}

// ---------------------------------------------------------------------------
// Gnosis contracts (all checked on chain 2026-11-02)
// ---------------------------------------------------------------------------

export type CowContracts = {
  settlement: Address; // GPv2Settlement: setPreSignature, the Trade events
  vaultRelayer: Address; // GPv2VaultRelayer: what the sell token is approved to
};

export const COW_CONTRACTS_BY_CHAIN: Record<number, CowContracts> = {
  [GNOSIS_CHAIN_ID]: {
    settlement: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    vaultRelayer: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110",
  },
};

export type BreadContracts = {
  bread: Address; // Breadchain BREAD: mint(address) payable 1:1, burn(uint256,address) 1:1
  wxdai: Address; // WETH9-style wrapped native coin: deposit() payable, withdraw(uint256)
};

export const BREAD_CONTRACTS_BY_CHAIN: Record<number, BreadContracts> = {
  [GNOSIS_CHAIN_ID]: {
    bread: "0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3",
    wxdai: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
  },
};

// Monerium EURe v2 — the same contract services/token/extra-tokens.ts
// registers as the "eure" display token.
export const EURE_BY_CHAIN: Record<number, Address> = {
  [GNOSIS_CHAIN_ID]: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430",
};

export const GNOSIS_ASSETS = {
  EURE: erc20Asset(GNOSIS_CHAIN_ID, EURE_BY_CHAIN[GNOSIS_CHAIN_ID]),
  WXDAI: erc20Asset(GNOSIS_CHAIN_ID, BREAD_CONTRACTS_BY_CHAIN[GNOSIS_CHAIN_ID].wxdai),
  BREAD: erc20Asset(GNOSIS_CHAIN_ID, BREAD_CONTRACTS_BY_CHAIN[GNOSIS_CHAIN_ID].bread),
} as const;
