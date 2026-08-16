// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { randomBytes } from "node:crypto";

import { decryptSecret } from "@/services/crypto/secret";

import type { CitizenPayClient } from "./client-interface";
import { LiveCitizenPayClient } from "./live-client";
import type {
  AddableOrdersPage,
  AddOrdersResult,
  ArchivedPayout,
  BankBalance,
  BankingStatus,
  BankTransactionPayloadPage,
  BankTransactionsPage,
  CardOperationInput,
  CardOperationResult,
  CitizenPayCardDetail,
  CitizenPayInvite,
  CitizenPayProfile,
  CreatedPayout,
  CreatedPayoutOrder,
  CreatePayoutOrderInput,
  CreatePayoutPaymentResult,
  FeeTransferResult,
  ListBankTransactionsInput,
  ListBankTransactionsResult,
  ListCardsInput,
  ListCardsResult,
  ListPlacesResult,
  OperationStatusResult,
  Payout,
  PayoutBurnReport,
  PayoutDeduction,
  PayoutDraft,
  PayoutDraftPreview,
  PayoutOrder,
  PayoutOrdersPage,
  PayoutPeriod,
  PayoutStatus,
  PayoutStatusDetail,
  RegisteredCard,
  RegisterCardInput,
  SetManualDeductionInput,
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

  async bulkCreateCards(
    serials: string[],
  ): Promise<{ created: number; conflicts: number }> {
    this.log("bulkCreateCards", { count: serials.length });
    return { created: serials.length, conflicts: 0 };
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

  async setCardSource(
    serialNumber: string,
    sourceSerial: string | null,
  ): Promise<void> {
    this.log("setCardSource", { serialNumber, sourceSerial });
    if (sourceSerial === null) mockCardSources.delete(serialNumber);
    else mockCardSources.set(serialNumber, sourceSerial);
  }

  async getCardSource(serialNumber: string): Promise<string | null> {
    this.log("getCardSource", { serialNumber });
    return mockCardSources.get(serialNumber) ?? null;
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

  async getTreasurySlug(): Promise<string | null> {
    this.log("getTreasurySlug", {});
    return "mock-network";
  }

  async listPayoutDrafts(
    query: { from?: string; to?: string } = {},
  ): Promise<PayoutDraft[]> {
    this.log("listPayoutDrafts", query);
    return [
      {
        businessId: "mock-business-1",
        placeId: "mock-place-1",
        placeName: "Mock Grocer",
        placeImage: null,
        orderCount: 42,
        total: "510.00",
        fees: "10.00",
        net: "500.00",
      },
      {
        businessId: "mock-business-2",
        placeId: "mock-place-2",
        placeName: "Mock Bakery",
        placeImage: null,
        orderCount: 7,
        total: "84.00",
        fees: "0.00",
        net: "84.00",
      },
    ];
  }

  async previewPayoutDraft(args: {
    placeId: string;
    from: string;
    to: string;
  }): Promise<PayoutDraftPreview> {
    this.log("previewPayoutDraft", args);
    return {
      businessId: "mock-business-1",
      placeId: args.placeId,
      placeName: "Mock Grocer",
      placeImage: null,
      orderCount: 18,
      total: "204.00",
      fees: "4.00",
      net: "200.00",
      from: args.from,
      to: args.to,
    };
  }

  async createPayout(args: {
    placeId: string;
    from: string;
    to: string;
  }): Promise<CreatedPayout> {
    this.log("createPayout", args);
    return {
      payoutId: `mock-payout-${randomBytes(4).toString("hex")}`,
      status: "pending",
      orderCount: 18,
      total: "204.00",
      fees: "4.00",
      net: "200.00",
      startDate: args.from,
      endDate: args.to,
    };
  }

  async getPayoutOrders(
    payoutId: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<PayoutOrdersPage> {
    this.log("getPayoutOrders", { payoutId, ...query });
    const orders: PayoutOrder[] = [
      {
        id: 44790,
        total: "28.32",
        fees: "1.42",
        net: "26.90",
        due: "26.90",
        status: "paid",
        type: "web",
        description: "Weekly grocery order",
        items: [
          { name: "Apples", quantity: 3, price: 450 },
          { name: "Bread", quantity: 1, price: 280 },
        ],
        // Settled: has a hash and a payer account.
        txHash: `0x${randomBytes(32).toString("hex")}`,
        account: `0x${randomBytes(20).toString("hex")}`,
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: 44791,
        total: "12.00",
        fees: "0.00",
        net: "12.00",
        due: "12.00",
        status: "paid",
        type: "pos",
        description: null,
        items: [],
        // Unsettled with a payer account → burn+mint fix branch.
        txHash: null,
        account: `0x${randomBytes(20).toString("hex")}`,
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: 44792,
        total: "5.50",
        fees: "0.00",
        net: "5.50",
        due: "5.50",
        status: "paid",
        type: "pos",
        description: null,
        items: [],
        // Unsettled with no payer account → mint-only fix branch.
        txHash: null,
        account: null,
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ];
    return {
      orders,
      total: orders.length,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      placeAccountAddress: `0x${randomBytes(20).toString("hex")}`,
    };
  }

  async recordOrderTxHash(
    payoutId: string,
    orderId: number,
    txHash: string,
  ): Promise<void> {
    this.log("recordOrderTxHash", { payoutId, orderId, txHash });
  }

  async createPayoutOrder(
    payoutId: string,
    input: CreatePayoutOrderInput,
  ): Promise<CreatedPayoutOrder> {
    this.log("createPayoutOrder", { payoutId, ...input });
    const total = Number(input.total);
    const fees = Number(input.fees);
    const net = (total - fees).toFixed(2);
    return {
      order: {
        id: parseInt(randomBytes(4).toString("hex"), 16),
        total: total.toFixed(2),
        fees: fees.toFixed(2),
        net,
        due: net,
        status: "paid",
        type: "manual",
        description: input.description,
        items: [],
        // Manual orders have no on-chain settlement yet → reconcile branch.
        txHash: null,
        account: null,
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      payout: { payoutId, total: total.toFixed(2), fees: fees.toFixed(2), net },
    };
  }

  async getAddableOrders(
    payoutId: string,
    query: { from: string; to: string; limit?: number; offset?: number },
  ): Promise<AddableOrdersPage> {
    this.log("getAddableOrders", { payoutId, ...query });
    // A couple of existing, unassigned orders that fell outside the payout's
    // original window. Amounts are EUR decimal strings like the live client.
    const orders: PayoutOrder[] = [
      {
        id: 45210,
        total: "18.99",
        fees: "0.95",
        net: "18.04",
        due: "18.04",
        status: "paid",
        type: "web",
        description: "Late-arriving order",
        items: [],
        txHash: `0x${randomBytes(32).toString("hex")}`,
        account: `0x${randomBytes(20).toString("hex")}`,
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: 45211,
        total: "7.50",
        fees: "0.38",
        net: "7.12",
        due: "7.12",
        status: "paid",
        type: "pos",
        description: null,
        items: [],
        txHash: `0x${randomBytes(32).toString("hex")}`,
        account: `0x${randomBytes(20).toString("hex")}`,
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ];
    return {
      orders,
      summary: {
        orderCount: orders.length,
        total: "26.49",
        fees: "1.33",
        net: "25.16",
      },
      total: orders.length,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    };
  }

  async addOrdersToPayout(
    payoutId: string,
    orderIds: number[],
  ): Promise<AddOrdersResult> {
    this.log("addOrdersToPayout", { payoutId, orderIds });
    return {
      assigned: orderIds.length,
      payout: { payoutId, total: "126.49", fees: "3.33", net: "123.16" },
    };
  }

  async archiveOrder(
    payoutId: string,
    orderId: number,
  ): Promise<ArchivedPayout> {
    this.log("archiveOrder", { payoutId, orderId });
    return { payoutId, total: "100.00", fees: "2.00", net: "98.00" };
  }

  async getBankingStatus(): Promise<BankingStatus> {
    this.log("getBankingStatus", {});
    return {
      connected: true,
      status: "active",
      accountReference: "BE68 5390 0754 7034",
      accountName: "Mock Treasury Account",
      onboardingComplete: true,
      paymentInitiationEnabled: true,
      paymentInitiationRequested: false,
      paymentRequestsEnabled: true,
      ready: true,
    };
  }

  async getBankingBalance(): Promise<BankBalance> {
    this.log("getBankingBalance", {});
    return {
      accountId: "mock-account-1",
      reference: "BE68 5390 0754 7034",
      currency: "EUR",
      availableBalance: 12345.67,
      currentBalance: 12345.67,
    };
  }

  async getBankingTransactions(
    query: { limit?: number; cursor?: string } = {},
  ): Promise<BankTransactionsPage> {
    this.log("getBankingTransactions", query);
    if (query.cursor) return { transactions: [], nextCursor: null };
    return {
      transactions: [
        {
          id: "mock-tx-1",
          amount: -28.32,
          currency: "EUR",
          executionDate: "2026-05-27",
          valueDate: "2026-05-27",
          counterpartName: "BEES Coop",
          counterpartReference: "BE71 0961 2345 6769",
          remittanceInformation: "cp-order-44790",
          remittanceInformationType: "structured",
          description: "Merchant payout",
          createdAt: new Date().toISOString(),
        },
        {
          id: "mock-tx-2",
          amount: 500,
          currency: "EUR",
          executionDate: "2026-05-26",
          valueDate: "2026-05-26",
          counterpartName: "Jane Member",
          counterpartReference: null,
          remittanceInformation: "Top-up",
          remittanceInformationType: "unstructured",
          description: "Incoming transfer",
          createdAt: new Date().toISOString(),
        },
        {
          // Bank-transfer-paid order (no on-chain payer account). The
          // structured reference `cp-order-{orderId}` lets the Fix dialog
          // surface this as the backing transfer for mock order 44792.
          id: "mock-tx-3",
          amount: 5.5,
          currency: "EUR",
          executionDate: "2026-05-25",
          valueDate: "2026-05-25",
          counterpartName: "Marie Dupont",
          counterpartReference: null,
          remittanceInformation: "cp-order-44792",
          remittanceInformationType: "structured",
          description: "Order payment",
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    };
  }

  async getBankTransactionPayloadPage(
    query: { limit?: number; cursor?: string } = {},
  ): Promise<BankTransactionPayloadPage> {
    this.log("getBankTransactionPayloadPage", query);
    // Reuse the same fixtures as the Bank page, adapted to the ingest shape so
    // the manual full-sync surfaces something to ingest in dev.
    const { transactions, nextCursor } = await this.getBankingTransactions(query);
    return {
      fetched: transactions.length,
      transactions: transactions.map((tx) => ({
        externalId: tx.id,
        direction: tx.amount < 0 ? "OUTGOING" : "INCOMING",
        amount: Math.abs(tx.amount).toFixed(2),
        currency: tx.currency,
        occurredAt:
          tx.executionDate ?? tx.valueDate ?? tx.createdAt ?? "2026-01-01",
        counterpartName: tx.counterpartName,
        counterpartIban: tx.counterpartReference,
        counterpartReference: null,
        remittanceInfo: tx.remittanceInformation,
        rawData: tx,
      })),
      nextCursor,
    };
  }

  async listPendingPayouts(): Promise<Payout[]> {
    this.log("listPendingPayouts", {});
    // Drop any the operator manually marked complete this session so dev
    // mirrors the real lists moving the payout pending → completed.
    return MOCK_PENDING_PAYOUTS.filter(
      (p) => !completedMockPayouts.has(p.id),
    ).map((p) => mockPayout(p.id, p.status, p.amount));
  }

  async listCompletedPayouts(): Promise<Payout[]> {
    this.log("listCompletedPayouts", {});
    const manuallyCompleted = MOCK_PENDING_PAYOUTS.filter((p) =>
      completedMockPayouts.has(p.id),
    ).map((p) => mockPayout(p.id, "complete", p.amount));
    return [
      ...manuallyCompleted,
      {
        ...mockPayout("mock-payout-0", "complete", "320.00"),
        burnTxHashes: [`0x${randomBytes(32).toString("hex")}`],
      },
    ];
  }

  async getPayout(payoutId: string): Promise<Payout> {
    this.log("getPayout", { payoutId });
    if (completedMockPayouts.has(payoutId)) {
      return mockPayout(payoutId, "complete", "150.00");
    }
    const fixture = MOCK_PENDING_PAYOUTS.find((p) => p.id === payoutId);
    if (fixture) return mockPayout(fixture.id, fixture.status, fixture.amount);
    if (payoutId === "mock-payout-0") {
      return {
        ...mockPayout("mock-payout-0", "complete", "320.00"),
        burnTxHashes: [`0x${randomBytes(32).toString("hex")}`],
      };
    }
    // Unknown id — synthesize a plausible pending payout so the detail page
    // still renders in dev.
    return mockPayout(payoutId, "pending", "150.00");
  }

  // Echoes the merged window the way CP does: an omitted field keeps the
  // payout's stored value. No totals in the reply — moving the dates never
  // moves money (the orders stay linked by id, not by date).
  async updatePayoutPeriod(
    payoutId: string,
    input: { startDate?: string; endDate?: string },
  ): Promise<PayoutPeriod> {
    this.log("updatePayoutPeriod", { payoutId, ...input });
    const base = await this.getPayout(payoutId);
    return {
      payoutId,
      startDate: input.startDate ?? base.startDate,
      endDate: input.endDate ?? base.endDate,
    };
  }

  async setManualDeduction(
    payoutId: string,
    input: SetManualDeductionInput,
  ): Promise<PayoutDeduction> {
    this.log("setManualDeduction", { payoutId, ...input });
    const base = await this.getPayout(payoutId);
    const deduction = Number(input.amount);
    const net = Number(base.totalAmount) - Number(base.totalFees) - deduction;
    return {
      payoutId,
      total: base.totalAmount,
      fees: base.totalFees,
      manualDeduction: deduction.toFixed(2),
      manualDeductionComment: input.comment,
      net: net.toFixed(2),
    };
  }

  async clearManualDeduction(payoutId: string): Promise<PayoutDeduction> {
    this.log("clearManualDeduction", { payoutId });
    const base = await this.getPayout(payoutId);
    const net = Number(base.totalAmount) - Number(base.totalFees);
    return {
      payoutId,
      total: base.totalAmount,
      fees: base.totalFees,
      manualDeduction: "0.00",
      manualDeductionComment: null,
      net: net.toFixed(2),
    };
  }

  async getPayoutStatus(
    payoutId: string,
    opts: { redirectUrl?: string } = {},
  ): Promise<PayoutStatusDetail> {
    this.log("getPayoutStatus", { payoutId, ...opts });
    const base = { feeTransferPending: false, feeTransferTxHash: null };
    // A manual "mark complete" wins over the fixture's lifecycle stage.
    if (completedMockPayouts.has(payoutId)) {
      return { status: "complete", signingUrl: null, ...base };
    }
    // Map the mock payouts so dev sees each lifecycle stage (and the signing
    // QR for the payment-pending one).
    if (payoutId === "mock-payout-2") {
      return {
        status: "payment-pending",
        signingUrl: "https://myponto.com/sign/mock-payout-2",
        ...base,
      };
    }
    if (payoutId === "mock-payout-0") {
      return { status: "complete", signingUrl: null, ...base };
    }
    return { status: "pending", signingUrl: null, ...base };
  }

  async createPayoutPayment(
    payoutId: string,
    args: { redirectUrl?: string } = {},
  ): Promise<CreatePayoutPaymentResult> {
    this.log("createPayoutPayment", { payoutId, ...args });
    const paymentId = randomBytes(8).toString("hex");
    return {
      alreadyCreated: false,
      paymentId,
      signingUrl: `https://my.citizenpay.xyz/sign/${paymentId}`,
    };
  }

  async burnPayout(
    payoutId: string,
    txHash: string,
    destination?: string,
  ): Promise<PayoutBurnReport> {
    this.log("burnPayout", { payoutId, txHash, destination });
    // Mock: the sweep "succeeds" inline when a destination is supplied.
    return {
      feeAmount: null,
      feeTransferTxHash: destination
        ? `0x${randomBytes(32).toString("hex")}`
        : null,
      feeTransferPending: false,
      feeTransferError: null,
    };
  }

  async feeTransfer(
    payoutId: string,
    destination: string,
  ): Promise<FeeTransferResult> {
    this.log("feeTransfer", { payoutId, destination });
    return {
      feeAmount: null,
      feeTransferTxHash: `0x${randomBytes(32).toString("hex")}`,
      alreadyTransferred: false,
    };
  }

  async completePayout(payoutId: string): Promise<void> {
    this.log("completePayout", { payoutId });
    completedMockPayouts.add(payoutId);
  }

  async setPayoutFeePercentage(percent: string): Promise<void> {
    this.log("setPayoutFeePercentage", { percent });
  }
}

// The pending fixtures, lifted to module scope so `completePayout` can move one
// to the completed list. `completedMockPayouts` persists across requests within
// the dev server process (the factory builds a fresh client per call) and
// resets on restart — good enough for dev.
const MOCK_PENDING_PAYOUTS: {
  id: string;
  status: PayoutStatus;
  amount: string;
}[] = [
  { id: "mock-payout-1", status: "pending", amount: "150.00" },
  { id: "mock-payout-2", status: "payment-pending", amount: "42.50" },
];
const completedMockPayouts = new Set<string>();

// Card → source-card assignments made this session, so the card detail page
// round-trips set/fetch in dev. Module-level: the factory hands out a fresh
// MockCitizenPayClient per call.
const mockCardSources = new Map<string, string>();

// Plausible dev payout. The place id is arbitrary — the mock `listPlaces`
// returns no places, so the settlement view falls back to showing the raw
// place id when it can't resolve a local Merchant.
function mockPayout(id: string, status: PayoutStatus, amount: string): Payout {
  const end = new Date();
  const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
  return {
    id,
    businessId: "mock-business-1",
    placeId: "mock-place-1",
    businessName: "Mock Grocer",
    placeName: "Mock Grocer",
    placeImage: null,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    totalAmount: amount,
    totalFees: "0.00",
    manualDeduction: "0.00",
    manualDeductionComment: null,
    net: amount,
    status,
    burnTxHashes: [],
    feeTransferPending: false,
    feeTransferTxHash: null,
    pontoPaymentId: null,
    pontoPaymentStatus: null,
    emailRecipient: null,
    emailSentAt: null,
    createdAt: start.toISOString(),
    updatedAt: end.toISOString(),
  };
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
