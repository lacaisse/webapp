// SPDX-License-Identifier: AGPL-3.0-or-later

// Fund Safe (multisig) — chain configuration and outbound URLs. Pure: no
// server-only, no DB, no fetch, so the UI can import it for links too.
//
// The feature manages standard Safe 1.4.1 accounts (SafeL2 singleton, created
// through the canonical SafeProxyFactory) owned N-of-M by per-member La Caisse
// signer keys and/or external addresses. These are NOT CitizenPay 4337
// accounts — CP's module bypasses the threshold. Transactions are
// `execTransaction` calls broadcast by La Caisse's relayer EOA, and proposals
// are mirrored to the Safe Transaction Service so external owners can sign in
// Safe{Wallet}.
//
// Module map (services/safe/*):
//   config.ts        — this file: chain ids, contract addresses, Safe{Wallet} /
//                      tx-service / explorer URLs. Pure.
//   abi.ts           — inline `as const` ABIs (Safe, SafeProxyFactory, ERC-20).
//   safe-tx.ts       — pure helpers: SafeTx building, EIP-712 hash, signature
//                      packing + recovery, owner-management calldata, CREATE2
//                      address prediction. Unit-tested, isomorphic.
//   signer.ts        — per-member signer keys (FundSigner rows, encrypted via
//                      services/crypto/secret.ts) and SafeTx signing. Server.
//   relayer.ts       — chain I/O through the relayer EOA: read Safe state,
//                      deploy a Safe, simulate + broadcast execTransaction.
//   tx-service.ts    — Safe Transaction Service HTTP client (no SDK).
//   proposals.ts     — propose / confirm / execute flows over DB + chain + TS.
//   sync.ts          — reconcile DB with chain + tx-service (cron + on view).
//   admin-actions.ts — "use server" actions behind app/(fund)/safes.
//   schemas.ts       — Zod schemas shared by forms and actions.
//   types.ts         — shared types + SafeError.

import { SafeError, type Address, type Hex } from "@/services/safe/types";

export const GNOSIS_CHAIN_ID = 100;

export type SafeContracts = {
  version: "1.4.1";
  singleton: Address;
  proxyFactory: Address;
  fallbackHandler: Address;
};

// Canonical Safe 1.4.1 deployments (safe-global/safe-deployments). Verified to
// have code on Gnosis; SafeL2.VERSION() returns "1.4.1". SafeL2 (not Safe)
// because it emits the SafeMultiSigTransaction events the tx-service indexes.
export const SAFE_CONTRACTS_BY_CHAIN: Record<number, SafeContracts> = {
  [GNOSIS_CHAIN_ID]: {
    version: "1.4.1",
    singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  },
};

export function safeContractsFor(chainId: number): SafeContracts {
  const contracts = SAFE_CONTRACTS_BY_CHAIN[chainId];
  if (!contracts) {
    throw new SafeError(
      "unsupported_chain",
      `Safe contracts are not configured for chain ${chainId}`,
    );
  }
  return contracts;
}

// EIP-3770 short names, as used by Safe{Wallet} (`gno:0x…`) and in the
// hosted tx-service path (`/tx-service/gno/api`).
export const SAFE_CHAIN_SHORT_NAMES: Record<number, string> = {
  [GNOSIS_CHAIN_ID]: "gno",
};

function shortNameFor(chainId: number): string {
  const short = SAFE_CHAIN_SHORT_NAMES[chainId];
  if (!short) {
    throw new SafeError(
      "unsupported_chain",
      `No Safe short name for chain ${chainId}`,
    );
  }
  return short;
}

const SAFE_APP_BASE = "https://app.safe.global";

// The URL helpers below also take plain strings: callers usually hold
// addresses / hashes straight from DB columns.

export function safeWalletUrl(chainId: number, address: Address | string): string {
  return `${SAFE_APP_BASE}/home?safe=${shortNameFor(chainId)}:${address}`;
}

export function safeWalletTxUrl(
  chainId: number,
  address: Address | string,
  safeTxHash: Hex | string,
): string {
  const safe = `${shortNameFor(chainId)}:${address}`;
  return `${SAFE_APP_BASE}/transactions/tx?safe=${safe}&id=multisig_${address}_${safeTxHash}`;
}

/**
 * Base URL of the Safe Transaction Service API for `chainId`, ending in
 * `/api` (paths are appended as `/v1/...`, `/v2/...`). `SAFE_TX_SERVICE_URL`
 * overrides it (self-hosted service, tests); otherwise the hosted service at
 * api.safe.global. Null when the chain has no Safe short name.
 */
export function txServiceBaseUrl(chainId: number): string | null {
  const override = process.env.SAFE_TX_SERVICE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const short = SAFE_CHAIN_SHORT_NAMES[chainId];
  if (!short) return null;
  return `https://api.safe.global/tx-service/${short}/api`;
}

const EXPLORER_BASE: Record<number, string> = {
  1: "https://etherscan.io",
  [GNOSIS_CHAIN_ID]: "https://gnosisscan.io",
};

// Unknown chains fall back to blockscan's multi-chain search so a link never
// throws in the UI.
function explorerBase(chainId: number): string {
  return EXPLORER_BASE[chainId] ?? "https://blockscan.com";
}

export function explorerTxUrl(chainId: number, txHash: Hex | string): string {
  return `${explorerBase(chainId)}/tx/${txHash}`;
}

export function explorerAddressUrl(chainId: number, address: Address | string): string {
  return `${explorerBase(chainId)}/address/${address}`;
}
