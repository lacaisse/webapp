// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { randomBytes } from "node:crypto";

import { decryptSecret } from "@/services/crypto/secret";

import type { CitizenPayClient } from "./client-interface";
import { LiveCitizenPayClient } from "./live-client";
import type {
  CardOperationInput,
  CardOperationResult,
  CitizenPayCardDetail,
  CitizenPayInvite,
  CitizenPayProfile,
  ListBankTransactionsInput,
  ListBankTransactionsResult,
  ListCardsInput,
  ListCardsResult,
  ListPlacesResult,
  OperationStatusResult,
  RegisteredCard,
  RegisterCardInput,
  SubmitMintInput,
  SubmittedOperation,
} from "./types";

// Re-export the interface so existing imports `from "@/services/citizenpay/client"`
// continue to resolve.
export type { CitizenPayClient } from "./client-interface";

// Minimum fund shape callers must `select` from Prisma. Keeping the column
// names exactly as on the model so call sites can pass `{ ...fund }` without
// renaming.
export type FundCredentials = {
  id: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

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
    return { transactions: [] };
  }

  async listPlaces(): Promise<ListPlacesResult> {
    this.log("listPlaces", {});
    return { places: [] };
  }

  async disconnectBusiness(businessId: string): Promise<void> {
    this.log("disconnectBusiness", { businessId });
  }

  async createMerchantInvite(args: {
    email: string;
    redirectUri?: string;
  }): Promise<CitizenPayInvite> {
    this.log("createMerchantInvite", args);
    const token = randomBytes(24).toString("hex");
    return {
      token,
      inviteUrl: `https://my.citizenpay.xyz/treasury-invites/${token}`,
      email: args.email,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      status: "pending",
      emailSent: true,
      emailSentAt: new Date().toISOString(),
      acceptedBusinessId: null,
    };
  }

  async getMerchantInvite(token: string): Promise<CitizenPayInvite | null> {
    this.log("getMerchantInvite", { token });
    // Mock can't know what state a token "should" be in. Return null —
    // dev flow never hits the callback against the mock client anyway.
    return null;
  }

  async getProfile(account: string): Promise<CitizenPayProfile | null> {
    this.log("getProfile", { account });
    return null;
  }

  async getProfiles(
    accounts: string[],
  ): Promise<Array<CitizenPayProfile | null>> {
    this.log("getProfiles", { count: accounts.length });
    return accounts.map(() => null);
  }

  async topUpCard(input: CardOperationInput): Promise<CardOperationResult> {
    this.log("topUpCard", input);
    return { txHash: `0x${randomBytes(32).toString("hex")}` };
  }

  async withdrawFromCard(
    input: CardOperationInput,
  ): Promise<CardOperationResult> {
    this.log("withdrawFromCard", input);
    return { txHash: `0x${randomBytes(32).toString("hex")}` };
  }

  async listCitizenPayCards(
    input: ListCardsInput = {},
  ): Promise<ListCardsResult> {
    this.log("listCitizenPayCards", input);
    return {
      cards: [],
      pagination: { page: 1, limit: input.limit ?? 100, total: 0, totalPages: 0 },
    };
  }

  async setCardStatus(
    serialNumber: string,
    status: "ACTIVE" | "INACTIVE" | "BLOCKED",
  ): Promise<void> {
    this.log("setCardStatus", { serialNumber, status });
  }

  async deleteCard(serialNumber: string): Promise<void> {
    this.log("deleteCard", { serialNumber });
  }

  async getCitizenPayCard(
    serialNumber: string,
  ): Promise<CitizenPayCardDetail | null> {
    this.log("getCitizenPayCard", { serialNumber });
    return null;
  }
}

// =============================================================================
// Factory
// =============================================================================

let warnedNoBaseUrl = false;

/**
 * Returns a CitizenPay client scoped to the given fund.
 *
 * Mode is decided by `CITIZENPAY_API_BASE_URL`:
 *   - **Unset**  → dev mode: an in-process mock that logs every call and
 *                  returns plausible data. Fund creds are ignored.
 *   - **Set**    → live mode: the fund **must** have both
 *                  `citizenPayApiKeyId` and `citizenPayApiKeyEnc` populated.
 *                  Missing creds throws — there's no silent fallback to the
 *                  mock once we're in live mode.
 *
 * The encrypted secret is decrypted with `CITIZENPAY_CRED_KEY` via
 * `services/citizenpay/crypto.ts`. Decrypt failures are fatal.
 *
 * No caching: clients are cheap to construct, and each call already has a
 * fund in scope.
 */
export function getCitizenPayClient(fund: FundCredentials): CitizenPayClient {
  const baseUrl = process.env.CITIZENPAY_API_BASE_URL;
  if (!baseUrl) {
    if (!warnedNoBaseUrl) {
      console.log(
        "[citizenpay] CITIZENPAY_API_BASE_URL not set — using mock client for all funds",
      );
      warnedNoBaseUrl = true;
    }
    return new MockCitizenPayClient();
  }

  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
    throw new Error(
      `[citizenpay] fund ${fund.id} is missing API credentials — set citizenPayApiKeyId + citizenPayApiKeyEnc (see scripts/encrypt-cp-secret.mjs)`,
    );
  }

  const apiKey = decryptSecret(fund.citizenPayApiKeyEnc);
  return new LiveCitizenPayClient({
    baseUrl,
    apiKeyId: fund.citizenPayApiKeyId,
    apiKey,
  });
}
