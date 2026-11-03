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
  // 0 = Call. 1 = DelegateCall, allowed to the chain's MultiSendCallOnly only
  // (a batch of plain calls) — safe-tx.ts::assertAllowedOperation.
  operation: 0 | 1;
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
      // Set when the swap moves a member's owner key: from a server-held
      // FundSigner to their passkey signer (`server_key`), or from a lost /
      // replaced passkey to the new one (`replaced_passkey`). Recorded so
      // the Safe's history says what the swap was for.
      migration?: OwnerMigrationReason;
    }
  | {
      kind: "CHANGE_THRESHOLD";
      threshold: number; // new threshold
      previousThreshold?: number; // on-chain threshold at proposal time
    }
  | {
      // One on-chain step of a token conversion (services/convert): a
      // MultiSendCallOnly batch, or a single call. Signers see what moves
      // and every inner call, never calldata.
      kind: "CONVERSION";
      conversionId: string;
      converterId: string; // registry id ("eure-bread")
      step: number; // 1-based: which of the conversion's proposals this is
      steps: number; // how many proposals the conversion takes in all
      label: string; // the leg's step label ("swap", "mint", "burn")
      from: { symbol: string; amount: string }; // the conversion's input
      to: { symbol: string; minAmount: string }; // the minimum it must yield
      // What the step needs beforehand and until when (a CoW order's validTo).
      validUntil?: string; // ISO
      calls: { to: Address; label: string; value?: string }[]; // value in wei when non-zero
    }
  | { kind: "REJECTION"; rejectsNonce: number };

// Why an owner row should be swapped for the member's current passkey
// signer (services/safe/migration.ts).
export type OwnerMigrationReason = "server_key" | "replaced_passkey";

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
  | "queue_full" // open-proposal cap reached (review S9)
  | "holds_value" // archive refused: the Safe still holds funds (review S7)
  | "passkey_missing" // a team owner has no (deployed) signing passkey for this fund
  | "passkey_exists" // the member already has an active signing passkey here
  | "passkey_replaced" // the member's owner on this Safe is a replaced passkey: swap it first
  | "passkey_replace_pending" // a previous replacement still owns a Safe: no new one until swapped
  | "passkey_rate_limited" // too many signing passkeys registered recently
  | "rules_spare_owner" // owner rules: owners must be ≥ threshold + 1 (lost-key recovery)
  | "rules_one_person" // owner rules: one person's keys alone must not meet the threshold
  | "server_key_retired" // LEGACY key no longer signs (migrated / erased)
  | "operation_refused" // DelegateCall to anything but MultiSendCallOnly
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
