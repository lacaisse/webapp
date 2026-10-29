// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared types for the fund Safe (multisig) feature. Pure — importable from
// client components, server actions and services alike. Everything that
// touches the chain or the DB lives in the sibling modules (see the header
// of services/safe/config.ts for the module map).

import type { ExtraTokenKey } from "@/services/token/extra-tokens";

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

// Safe 1.4.1 `SafeTx` struct (what execTransaction consumes and what the
// EIP-712 `safeTxHash` is computed over). Gas fields are always zero here:
// our relayer pays the gas and asks for no refund.
export type SafeTx = {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1; // 0 = Call, 1 = DelegateCall (never used by us)
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
};

// Human summary stored on FundSafeTransaction.summary (JSON) — the UI renders
// a transaction from this, never by decoding calldata. `*Label` fields are
// resolved at proposal time (member name, account name, external owner
// label) so history stays readable after renames.
export type SafeTxSummary =
  | {
      kind: "TOKEN_TRANSFER";
      amount: string; // human decimal in token units ("12.50")
      recipient: Address;
      recipientLabel: string | null;
      // Which balance moved ("fund", "native", "eure" or a custom token's
      // `custom:<lowercased address>`). Missing on rows written before
      // multi-token transfers: treat as "fund" (and show the fund's symbol).
      token?: "fund" | ExtraTokenKey;
      symbol?: string; // frozen at proposal time ("EURe", "xDAI", "USDC.e", fund symbol)
      // The ERC-20 contract the Safe calls (checksummed), null for the native
      // coin (a plain value transfer). Lets signers see which contract really
      // moves, not just a symbol. Missing on rows written before it existed.
      contract?: Address | null;
    }
  | {
      kind: "ADD_OWNER";
      owner: Address;
      ownerLabel: string | null;
      threshold: number; // threshold after the change
      // On-chain threshold when the change was proposed (so the UI can show
      // "2 → 1"). Missing on rows written before it existed.
      previousThreshold?: number;
    }
  | {
      kind: "REMOVE_OWNER";
      owner: Address;
      ownerLabel: string | null;
      threshold: number; // threshold after the change
      previousThreshold?: number; // on-chain threshold at proposal time
    }
  | {
      kind: "SWAP_OWNER";
      oldOwner: Address;
      oldOwnerLabel: string | null;
      newOwner: Address;
      newOwnerLabel: string | null;
    }
  | {
      kind: "CHANGE_THRESHOLD";
      threshold: number; // new threshold
      previousThreshold?: number; // on-chain threshold at proposal time
    }
  | { kind: "REJECTION"; rejectsNonce: number };

export type SafeErrorCode =
  | "config" // env / contracts missing
  | "unsupported_chain"
  | "relayer_not_configured"
  | "relayer_failed" // send / receipt failure before or without a mined tx
  | "tx_reverted" // mined but status 0, or simulation reverted
  | "tx_service" // Safe Transaction Service HTTP / shape error
  | "not_owner" // the acting signer is not an owner of the Safe
  | "already_signed"
  | "threshold" // not enough signatures to execute
  | "nonce" // stale / conflicting nonce
  | "invalid_signature"
  | "not_found"
  | "invalid_state"; // e.g. acting on a non-ACTIVE safe or non-PENDING tx

export class SafeError extends Error {
  readonly code: SafeErrorCode;
  constructor(code: SafeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SafeError";
    this.code = code;
  }
}

export function isSafeError(e: unknown): e is SafeError {
  return e instanceof SafeError;
}
