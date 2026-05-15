// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { randomBytes } from "node:crypto";

import type {
  ListBankTransactionsInput,
  ListBankTransactionsResult,
  OperationStatusResult,
  RegisteredCard,
  RegisterCardInput,
  SubmitMintInput,
  SubmittedOperation,
} from "./types";

// CitizenPay API surface we'll need. Each method represents a discrete
// operation the CP API exposes (or will expose — the contract is still
// being finalised, so this interface is what we *expect* it to look like).
//
// The mock implementation logs every call and returns plausible data so the
// app can run end-to-end in dev without a live CP connection. When the real
// CP integration is ready, write a LiveCitizenPayClient implementing the
// same interface and switch the factory.

export interface CitizenPayClient {
  /**
   * Register a physical card with CitizenPay. The fund hands a card with a
   * known NFC serial to a member; we call this to create the corresponding
   * on-chain wallet on CP's side. Returns the wallet `account` we then
   * store on the local Card row.
   */
  registerCard(input: RegisterCardInput): Promise<RegisteredCard>;

  /**
   * Tell CP to stop accepting charges from this card (member reported lost,
   * suspicious activity, etc.). Idempotent — calling it on an already-
   * blocked card is a no-op.
   */
  blockCard(serialNumber: string): Promise<void>;

  /** Reverse of `blockCard`. Idempotent. */
  unblockCard(serialNumber: string): Promise<void>;

  /**
   * Submit a mint to CP. Returns a tx hash we can poll later for
   * confirmation. The mint itself is asynchronous on-chain — initial status
   * is always PENDING.
   */
  submitMint(input: SubmitMintInput): Promise<SubmittedOperation>;

  /**
   * Poll CP for the current state of a previously-submitted operation.
   * The polling cron uses this to flip PENDING rows to CONFIRMED / FAILED.
   */
  getOperationStatus(txHash: string): Promise<OperationStatusResult>;

  /**
   * Fetch bank movements CP has detected on the fund's account, optionally
   * since a cursor. Bank-sync uses this to mirror deposits locally, match
   * them to members, and trigger PAY_AND_GO mints.
   */
  listBankTransactions(
    input: ListBankTransactionsInput,
  ): Promise<ListBankTransactionsResult>;
}

// =============================================================================
// Mock implementation
// =============================================================================

class MockCitizenPayClient implements CitizenPayClient {
  private log(method: string, details: Record<string, unknown>): void {
    console.log(`[citizenpay:mock] ${method}`, details);
  }

  async registerCard(input: RegisterCardInput): Promise<RegisteredCard> {
    this.log("registerCard", input);
    return {
      serialNumber: input.serialNumber,
      // 0x + 40 hex chars — looks like an ETH address. Real CP probably
      // returns something similar.
      account: `0x${randomBytes(20).toString("hex")}`,
      // INACTIVE until CP confirms terminal-readiness (separate signal).
      status: "INACTIVE",
    };
  }

  async blockCard(serialNumber: string): Promise<void> {
    this.log("blockCard", { serialNumber });
  }

  async unblockCard(serialNumber: string): Promise<void> {
    this.log("unblockCard", { serialNumber });
  }

  async submitMint(input: SubmitMintInput): Promise<SubmittedOperation> {
    this.log("submitMint", input);
    return {
      txHash: `0x${randomBytes(32).toString("hex")}`,
      status: "PENDING",
    };
  }

  async getOperationStatus(txHash: string): Promise<OperationStatusResult> {
    this.log("getOperationStatus", { txHash });
    return { txHash, status: "CONFIRMED" };
  }

  async listBankTransactions(
    input: ListBankTransactionsInput,
  ): Promise<ListBankTransactionsResult> {
    this.log("listBankTransactions", input);
    // Mock returns empty — bank-sync cron runs but does nothing in dev.
    // When CP integration is live, this returns the real backlog of
    // transactions since the cursor.
    return { transactions: [] };
  }
}

// =============================================================================
// Factory
// =============================================================================

let cached: CitizenPayClient | undefined;

/**
 * Returns the active CitizenPay client. Defaults to a mock that logs each
 * call and returns plausible data. The mock is used until a LiveCitizenPayClient
 * implementation is wired against the real CP API. Use everywhere CP needs to
 * be called — never instantiate the client directly from call sites.
 */
export function getCitizenPayClient(): CitizenPayClient {
  if (cached) return cached;
  cached = new MockCitizenPayClient();
  return cached;
}
