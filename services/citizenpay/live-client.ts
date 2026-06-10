// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";

import {
  banking as apiBanking,
  businesses as apiBusinesses,
  cards as apiCards,
  invites as apiInvites,
  payouts as apiPayouts,
  places as apiPlaces,
  profiles as apiProfiles,
  treasury as apiTreasury,
  PROFILES_BATCH_MAX,
  type CitizenPayApiCredentials,
  CitizenPayApiError,
  type InviteWire,
  type PaginatedCards,
  type ManualDeductionWire,
  type PayoutDraftWire,
  type PayoutDetailWire,
  type PayoutListPageWire,
  type PayoutListWire,
  type PayoutOrderWire,
  type BankTransactionWire,
} from "./api";
import type { CitizenPayClient } from "./client-interface";
import type {
  ArchivedPayout,
  BankBalance,
  BankingStatus,
  BankTransactionPayload,
  BankTransactionPayloadPage,
  BankTransactionsPage,
  CardOperationInput,
  CardOperationResult,
  CardStatus,
  CitizenPayCard,
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
  PayoutStatusDetail,
  RegisteredCard,
  RegisterCardInput,
  SetManualDeductionInput,
  SubmitMintInput,
  SubmittedOperation,
} from "./types";

// Adapts the OpenAPI-shaped low-level api.ts to the high-level interface the
// rest of the app already uses (registerCard, blockCard, submitMint, …).
//
// Conversions:
//   - Decimal "1.50" EUR  ↔  integer cents (150)
//   - 'active'/'inactive'/'blocked'  ↔  'ACTIVE'/'INACTIVE'/'BLOCKED'
//   - submitMint takes a wallet address; the real API takes a card serial.
//     We look up the serial via Prisma (Card.account is @unique).
//
// Gaps vs. the OpenAPI spec (intentional — see AGENTS.md "Framework gotchas
// → CitizenPay"):
//   - `getOperationStatus`: top-up/charge/withdraw are synchronous in the
//     v2 API. We return CONFIRMED for any txHash the polling cron passes in.
//   - `listBankTransactions` (bank-sync cron) is served by the same
//     `/v2/treasury/banking/transactions` feed the Bank page reads. It's
//     cursor-paginated newest-first, so we page backwards until we cross the
//     `since` watermark (or exhaust history on the initial full load) and
//     adapt the wire shape (signed amount → direction + magnitude) to the
//     ingest payload.

function toCents(decimal: string | Prisma.Decimal): number {
  const d = decimal instanceof Prisma.Decimal ? decimal : new Prisma.Decimal(decimal);
  // Round to 2dp first to avoid floating-point hex from a previously-stored
  // value like "1.234999..." sneaking through.
  return d.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

function centsToDecimal(cents: number | null | undefined): string {
  // Live payout rows occasionally omit a numeric field (e.g. total_fees /
  // manual_deduction on older completed payouts). Treat anything non-finite
  // as 0 rather than throwing a DecimalError mid-render.
  const n = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return new Prisma.Decimal(n).div(100).toFixed(2);
}

// Adapt a banking-feed transaction (signed amount, Ponto field names) to the
// ingest payload (direction + magnitude). `counterpartReference` from the feed
// is the counterpart's IBAN, so it maps to `counterpartIban` (where the member
// matcher expects it) rather than `counterpartReference`. The member payment
// reference travels in the structured remittance info.
function payloadFromBankingWire(
  tx: BankTransactionWire,
  occurredAt: string,
): BankTransactionPayload {
  return {
    externalId: tx.id,
    direction: tx.amount < 0 ? "OUTGOING" : "INCOMING",
    amount: new Prisma.Decimal(tx.amount).abs().toFixed(2),
    currency: tx.currency || "EUR",
    occurredAt,
    counterpartName: tx.counterpartName ?? null,
    counterpartIban: tx.counterpartReference ?? null,
    counterpartReference: null,
    remittanceInfo: tx.remittanceInformation ?? null,
    rawData: tx,
  };
}

function payoutFromListWire(w: PayoutListWire): Payout {
  return {
    id: w.payoutId,
    businessId: w.businessId,
    placeId: w.placeId,
    businessName: w.businessName ?? null,
    placeName: w.placeName ?? null,
    placeImage: w.placeImage || null,
    startDate: w.startDate,
    endDate: w.endDate,
    totalAmount: centsToDecimal(w.total),
    totalFees: centsToDecimal(w.fees),
    manualDeduction: centsToDecimal(w.manualDeduction),
    manualDeductionComment: null,
    net: centsToDecimal(w.net),
    status: w.status,
    // Burn hashes / ponto id / emails aren't in the list shape — they live
    // on the order/status endpoints. Surface what the list gives us.
    burnTxHashes: [],
    feeTransferPending: w.feeTransferPending ?? false,
    feeTransferTxHash: w.feeTransferTxHash ?? null,
    pontoPaymentId: null,
    pontoPaymentStatus: w.pontoPaymentStatus ?? null,
    emailRecipient: null,
    emailSentAt: null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

// Detail wire = list-row shape + the manual-deduction comment. Reuse the list
// normaliser and layer the extra field on top.
function payoutFromDetailWire(w: PayoutDetailWire): Payout {
  return {
    ...payoutFromListWire(w),
    manualDeductionComment: w.manualDeductionComment ?? null,
  };
}

// Recomputed totals returned by set/clear manual-deduction — cents → decimal.
function deductionFromWire(p: ManualDeductionWire["payout"]): PayoutDeduction {
  return {
    payoutId: p.payoutId,
    total: centsToDecimal(p.total),
    fees: centsToDecimal(p.fees),
    manualDeduction: centsToDecimal(p.manualDeduction),
    manualDeductionComment: p.manualDeductionComment ?? null,
    net: centsToDecimal(p.net),
  };
}

function draftFromWire(w: PayoutDraftWire): PayoutDraft {
  return {
    businessId: w.businessId,
    placeId: w.placeId,
    placeName: w.placeName,
    placeImage: w.placeImage || null,
    orderCount: w.orderCount,
    total: centsToDecimal(w.total),
    fees: centsToDecimal(w.fees),
    net: centsToDecimal(w.net),
  };
}

function payoutOrderFromWire(w: PayoutOrderWire): PayoutOrder {
  const totalC = typeof w.total === "number" ? w.total : 0;
  const feesC = typeof w.fees === "number" ? w.fees : 0;
  return {
    id: w.id,
    total: centsToDecimal(totalC),
    fees: centsToDecimal(feesC),
    // net = total − fees, computed from cents (the wire `due` is unreliable).
    net: centsToDecimal(totalC - feesC),
    due: centsToDecimal(w.due),
    status: w.status,
    type: w.type,
    description: w.description ?? null,
    items: Array.isArray(w.items) ? w.items : [],
    txHash: w.txHash ?? w.tx_hash ?? null,
    account: w.account || null,
    completedAt: w.completed_at ?? w.date ?? null,
  };
}

function statusFromWire(s: "active" | "inactive" | "blocked"): CardStatus {
  if (s === "active") return "ACTIVE";
  if (s === "blocked") return "BLOCKED";
  return "INACTIVE";
}

function cardFromWire(w: {
  serial: string;
  status: "active" | "inactive" | "blocked";
  owner?: string | null;
  source_serial?: string | null;
  created_at: string;
  last_activity?: string | null;
}): CitizenPayCard {
  return {
    serialNumber: w.serial,
    status: statusFromWire(w.status),
    owner: w.owner ?? null,
    // CP omits the field (or sends "") when no source is set.
    sourceSerial: w.source_serial || null,
    createdAt: w.created_at,
    lastActivity: w.last_activity ?? null,
  };
}

function inviteFromWire(w: InviteWire): CitizenPayInvite {
  return {
    token: w.token,
    inviteUrl: w.invite_url,
    email: w.email,
    expiresAt: w.expires_at,
    status: w.status,
    emailSent: w.email_sent,
    emailSentAt: w.email_sent_at ?? null,
    acceptedBusinessId: w.accepted_business_id ?? null,
  };
}

export class LiveCitizenPayClient implements CitizenPayClient {
  constructor(private readonly creds: CitizenPayApiCredentials) {}

  async registerCard(input: RegisterCardInput): Promise<RegisteredCard> {
    // Two-step: create the card, then read its balance to pick up the
    // on-chain address. The spec's Card schema doesn't include the address
    // on create; balance is where it lives.
    const card = await apiCards.create(this.creds, input.serialNumber);
    let account = "";
    try {
      const bal = await apiCards.balance(this.creds, input.serialNumber);
      account = bal.address;
    } catch (e) {
      // Don't block card creation if balance lookup hiccups. Caller already
      // tolerates account=null. Surfaced as empty so the @unique constraint
      // doesn't get a fake value; caller will keep it null.
      console.warn("[citizenpay] balance lookup after create failed", e);
    }
    return {
      serialNumber: card.serial,
      // Lowercased so it matches the on-chain hex everywhere downstream
      // (Card.account, address-profile cache, transfer labels).
      account: account.toLowerCase(),
      status: statusFromWire(card.status),
    };
  }

  async bulkCreateCards(
    serials: string[],
  ): Promise<{ created: number; conflicts: number }> {
    return apiCards.bulkCreate(this.creds, serials);
  }

  async blockCard(serialNumber: string): Promise<void> {
    try {
      await apiCards.update(this.creds, serialNumber, { status: "blocked" });
    } catch (e) {
      // Idempotency: if CP rejects because it's already in the target state,
      // treat as success. The spec doesn't promise idempotent semantics,
      // so we tolerate 4xx with a status-already-set body.
      if (e instanceof CitizenPayApiError && e.status === 409) return;
      throw e;
    }
  }

  async unblockCard(serialNumber: string): Promise<void> {
    try {
      await apiCards.update(this.creds, serialNumber, { status: "active" });
    } catch (e) {
      if (e instanceof CitizenPayApiError && e.status === 409) return;
      throw e;
    }
  }

  async submitMint(input: SubmitMintInput): Promise<SubmittedOperation> {
    // The OpenAPI top-up endpoint identifies the card by serial, but our
    // internal call sites carry the on-chain account. Resolve via Prisma.
    const card = await prisma.card.findUnique({
      where: { account: input.toAccount },
      select: { serialNumber: true },
    });
    if (!card) {
      throw new Error(
        `[citizenpay] submitMint: no Card row for account ${input.toAccount}`,
      );
    }

    const result = await apiCards.topUp(
      this.creds,
      card.serialNumber,
      toCents(input.amount),
    );
    return { txHash: result.txHash, status: "PENDING" };
  }

  async getOperationStatus(txHash: string): Promise<OperationStatusResult> {
    // Top-up/charge/withdraw are synchronous on CitizenPay v2 — the
    // returned txHash is already on-chain by the time we see it. There's no
    // poll endpoint. Return CONFIRMED so the status-polling cron flips the
    // row on the next tick.
    return { txHash, status: "CONFIRMED" };
  }

  async getBankTransactionPayloadPage(
    query: { limit?: number; cursor?: string } = {},
  ): Promise<BankTransactionPayloadPage> {
    // One page of `/v2/treasury/banking/transactions` (the same feed the Bank
    // page reads), adapted to the ingest payload shape. Newest-first; pass the
    // returned cursor back for older pages.
    const w = await apiBanking.transactions(this.creds, {
      limit: query.limit ?? 100,
      cursor: query.cursor,
    });
    const raw = w.transactions ?? [];
    const transactions: BankTransactionPayload[] = [];
    for (const tx of raw) {
      const occurredAt = tx.executionDate ?? tx.valueDate ?? tx.createdAt;
      // Can't place it in time → can't store a sane occurredAt. Skip rather
      // than guess.
      if (!occurredAt) continue;
      transactions.push(payloadFromBankingWire(tx, occurredAt));
    }
    // CP's handler returns a Go zero-value `""` (never null) at end of
    // history — normalise to null so callers' done checks work.
    return { transactions, nextCursor: w.nextCursor || null, fetched: raw.length };
  }

  async listBankTransactions(
    input: ListBankTransactionsInput,
  ): Promise<ListBankTransactionsResult> {
    // Cron path: page the banking feed (newest-first) and stop as soon as we
    // cross the `since` watermark. With no `since` (first sync) we page until
    // history is exhausted. The ingest upsert is idempotent on
    // (fundId, externalId), so incidental overlap on the boundary is harmless.
    const PAGE_SIZE = 100;
    // Runaway guard for the first full sync. 200 pages × 100 = 20k rows; we
    // log if we hit it so a silently-truncated history is visible.
    const MAX_PAGES = 200;
    const sinceMs = input.since ? Date.parse(input.since) : null;

    const out: BankTransactionPayload[] = [];
    let cursor: string | undefined;
    let reachedWatermark = false;
    let page = 0;
    for (; page < MAX_PAGES; page++) {
      const { transactions, nextCursor, fetched } =
        await this.getBankTransactionPayloadPage({ limit: PAGE_SIZE, cursor });
      for (const tx of transactions) {
        if (sinceMs !== null && Date.parse(tx.occurredAt) <= sinceMs) {
          reachedWatermark = true;
          break;
        }
        out.push(tx);
      }
      // Stop on the watermark, an empty raw page (nothing left even if a stale
      // cursor lingers), or an absent next cursor.
      if (reachedWatermark || fetched === 0 || !nextCursor) break;
      cursor = nextCursor;
    }

    if (page >= MAX_PAGES && !reachedWatermark) {
      console.warn(
        "[citizenpay] listBankTransactions hit MAX_PAGES — older transactions may be unsynced",
        { fundCitizenPayId: input.fundCitizenPayId, maxPages: MAX_PAGES },
      );
    }

    return { transactions: out };
  }

  async listPlaces(): Promise<ListPlacesResult> {
    const { places } = await apiPlaces.list(this.creds);
    return {
      places: places.map((p) => ({
        id: p.id,
        businessId: p.business_id ?? null,
        name: p.name,
        // Lowercase to match the convention used by Card.account and the
        // address-profile cache. CP normalises on its side too.
        account: p.account_address ? p.account_address.toLowerCase() : null,
        balanceCents: typeof p.balance === "number" ? p.balance : null,
        address: p.address ?? null,
        city: p.city ?? null,
        country: p.country ?? null,
        postalCode: p.zip_code ?? null,
        latitude: typeof p.latitude === "number" ? p.latitude : null,
        longitude: typeof p.longitude === "number" ? p.longitude : null,
      })),
    };
  }

  async disconnectBusiness(businessId: string): Promise<void> {
    try {
      await apiBusinesses.disconnect(this.creds, businessId);
    } catch (e) {
      // Idempotent — a 404 means CP no longer associates this business
      // with the treasury (admin double-clicked, race with another tab,
      // CP-side cleanup, etc.). Treat as success and let the caller go
      // ahead and clear the local rows.
      if (e instanceof CitizenPayApiError && e.status === 404) return;
      throw e;
    }
  }

  async createMerchantInvite(args: {
    email: string;
    redirectUri?: string;
  }): Promise<CitizenPayInvite> {
    const wire = await apiInvites.create(this.creds, args);
    return inviteFromWire(wire);
  }

  async getMerchantInvite(token: string): Promise<CitizenPayInvite | null> {
    try {
      const wire = await apiInvites.get(this.creds, token);
      return inviteFromWire(wire);
    } catch (e) {
      if (e instanceof CitizenPayApiError && e.status === 404) return null;
      throw e;
    }
  }

  async topUpCard(input: CardOperationInput): Promise<CardOperationResult> {
    const result = await apiCards.topUp(
      this.creds,
      input.serialNumber,
      toCents(input.amount),
    );
    return { txHash: result.txHash };
  }

  async withdrawFromCard(
    input: CardOperationInput,
  ): Promise<CardOperationResult> {
    const result = await apiCards.withdraw(
      this.creds,
      input.serialNumber,
      toCents(input.amount),
    );
    return { txHash: result.txHash };
  }

  async listCitizenPayCards(
    input: ListCardsInput = {},
  ): Promise<ListCardsResult> {
    // Iterate pages until exhausted. CP caps `limit` at 100; default to
    // the max so we minimise round-trips against treasuries with many
    // cards. Caller-supplied `page`/`limit` skip the loop and return a
    // single page (used by the future paginated UI; today's reconcile
    // view wants everything).
    //
    // CP returns `cards: null` (not an empty array) when the treasury
    // has no cards — and the `pagination` block can be missing entirely
    // on small / empty responses. Normalise both before consuming.
    const limit = Math.min(input.limit ?? 100, 100);
    const normalisePagination = (
      p: PaginatedCards["pagination"],
      pageFallback: number,
    ): {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    } => ({
      page: p?.page ?? pageFallback,
      limit: p?.limit ?? limit,
      total: p?.total ?? 0,
      totalPages: p?.totalPages ?? 0,
    });

    if (input.page !== undefined) {
      const res = await apiCards.list(this.creds, { page: input.page, limit });
      const cards = res.cards ?? [];
      return {
        cards: cards.map(cardFromWire),
        pagination: normalisePagination(res.pagination, input.page),
      };
    }

    const all: CitizenPayCard[] = [];
    let page = 1;
    let totalPages = 1;
    let total = 0;
    while (page <= totalPages) {
      const res = await apiCards.list(this.creds, { page, limit });
      const cards = res.cards ?? [];
      all.push(...cards.map(cardFromWire));
      const pagination = normalisePagination(res.pagination, page);
      total = pagination.total;
      totalPages = pagination.totalPages;
      page += 1;
      // Safety: if CP ever returns inconsistent pagination, cap at 50
      // pages (5000 cards at limit=100). Real treasuries are far smaller.
      if (page > 50) break;
    }
    return {
      cards: all,
      pagination: { page: 1, limit, total, totalPages },
    };
  }

  async setCardStatus(
    serialNumber: string,
    status: "ACTIVE" | "INACTIVE" | "BLOCKED",
  ): Promise<void> {
    const wire =
      status === "ACTIVE" ? "active" : status === "BLOCKED" ? "blocked" : "inactive";
    try {
      await apiCards.update(this.creds, serialNumber, { status: wire });
    } catch (e) {
      if (e instanceof CitizenPayApiError && e.status === 409) return;
      throw e;
    }
  }

  async setCardSource(
    serialNumber: string,
    sourceSerial: string | null,
  ): Promise<void> {
    // Empty string is CP's "clear the source" sentinel on the PATCH.
    await apiCards.update(this.creds, serialNumber, {
      source_serial: sourceSerial ?? "",
    });
  }

  async getCardSource(serialNumber: string): Promise<string | null> {
    try {
      const res = await apiCards.get(this.creds, serialNumber);
      return res.card.source_serial || null;
    } catch (e) {
      if (e instanceof CitizenPayApiError && e.status === 404) return null;
      throw e;
    }
  }

  async getCitizenPayCard(
    serialNumber: string,
  ): Promise<CitizenPayCardDetail | null> {
    let cardWire;
    try {
      const res = await apiCards.get(this.creds, serialNumber);
      cardWire = res.card;
    } catch (e) {
      if (e instanceof CitizenPayApiError && e.status === 404) return null;
      throw e;
    }
    let account: string | null = null;
    try {
      const bal = await apiCards.balance(this.creds, serialNumber);
      // Lowercase to match the convention used by Card.account writers.
      account = bal.address ? bal.address.toLowerCase() : null;
    } catch (e) {
      // Balance lookup failure shouldn't block the read — the row is
      // already created, just won't have an on-chain link until the
      // next sync.
      console.warn(
        "[citizenpay] balance lookup during getCitizenPayCard failed",
        e,
      );
    }
    return {
      ...cardFromWire(cardWire),
      account,
    };
  }

  async deleteCard(serialNumber: string): Promise<void> {
    try {
      await apiCards.delete(this.creds, serialNumber);
    } catch (e) {
      // Treat 404 as already-deleted so the action is idempotent — useful
      // when the admin clicks "remove from CP" after a previous click
      // already succeeded but the page wasn't refreshed.
      if (e instanceof CitizenPayApiError && e.status === 404) return;
      throw e;
    }
  }

  async getProfile(account: string): Promise<CitizenPayProfile | null> {
    try {
      const wire = await apiProfiles.get(this.creds, account);
      return wireToProfile(wire);
    } catch (e) {
      if (e instanceof CitizenPayApiError && e.status === 404) return null;
      throw e;
    }
  }

  async getProfiles(
    accounts: string[],
  ): Promise<Array<CitizenPayProfile | null>> {
    if (accounts.length === 0) return [];
    // Chunk to CP's per-request cap. Concurrency is fine here — each chunk
    // is an independent POST against the same endpoint.
    const chunks: string[][] = [];
    for (let i = 0; i < accounts.length; i += PROFILES_BATCH_MAX) {
      chunks.push(accounts.slice(i, i + PROFILES_BATCH_MAX));
    }
    const responses = await Promise.all(
      chunks.map((chunk) => apiProfiles.getMany(this.creds, chunk)),
    );
    return responses.flatMap((r) =>
      r.profiles.map((wire) => (wire ? wireToProfile(wire) : null)),
    );
  }

  async listPayoutDrafts(
    query: { from?: string; to?: string } = {},
  ): Promise<PayoutDraft[]> {
    const { drafts } = await apiPayouts.listDrafts(this.creds, query);
    return (drafts ?? []).map(draftFromWire);
  }

  async previewPayoutDraft(args: {
    placeId: string;
    from: string;
    to: string;
  }): Promise<PayoutDraftPreview> {
    const w = await apiPayouts.previewDraft(this.creds, args);
    return { ...draftFromWire(w), from: w.from, to: w.to };
  }

  async createPayout(args: {
    placeId: string;
    from: string;
    to: string;
  }): Promise<CreatedPayout> {
    const w = await apiPayouts.create(this.creds, args);
    return {
      payoutId: w.payoutId,
      status: w.status,
      orderCount: w.orderCount,
      total: centsToDecimal(w.total),
      fees: centsToDecimal(w.fees),
      net: centsToDecimal(w.net),
      startDate: w.startDate,
      endDate: w.endDate,
    };
  }

  async getPayoutOrders(
    payoutId: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<PayoutOrdersPage> {
    const res = await apiPayouts.orders(this.creds, payoutId, query);
    const orders = (res.orders ?? []).map(payoutOrderFromWire);
    return {
      orders,
      total: res.total ?? orders.length,
      limit: res.limit,
      offset: res.offset,
      placeAccountAddress: res.placeAccountAddress
        ? res.placeAccountAddress.toLowerCase()
        : null,
    };
  }

  async recordOrderTxHash(
    payoutId: string,
    orderId: number,
    txHash: string,
  ): Promise<void> {
    await apiPayouts.setOrderTxHash(this.creds, payoutId, orderId, txHash);
  }

  async createPayoutOrder(
    payoutId: string,
    input: CreatePayoutOrderInput,
  ): Promise<CreatedPayoutOrder> {
    const res = await apiPayouts.createOrder(this.creds, payoutId, {
      total: toCents(input.total),
      fees: toCents(input.fees),
      description: input.description,
    });
    return {
      order: payoutOrderFromWire(res.order),
      payout: {
        payoutId: res.payout.payoutId,
        total: centsToDecimal(res.payout.total),
        fees: centsToDecimal(res.payout.fees),
        net: centsToDecimal(res.payout.net),
      },
    };
  }

  async archiveOrder(
    payoutId: string,
    orderId: number,
  ): Promise<ArchivedPayout> {
    const { payout } = await apiPayouts.archiveOrder(
      this.creds,
      payoutId,
      orderId,
    );
    return {
      payoutId: payout.payoutId,
      total: centsToDecimal(payout.total),
      fees: centsToDecimal(payout.fees),
      net: centsToDecimal(payout.net),
    };
  }

  async setManualDeduction(
    payoutId: string,
    input: SetManualDeductionInput,
  ): Promise<PayoutDeduction> {
    const { payout } = await apiPayouts.setManualDeduction(this.creds, payoutId, {
      manualDeduction: toCents(input.amount),
      comment: input.comment,
    });
    return deductionFromWire(payout);
  }

  async clearManualDeduction(payoutId: string): Promise<PayoutDeduction> {
    const { payout } = await apiPayouts.clearManualDeduction(this.creds, payoutId);
    return deductionFromWire(payout);
  }

  async getBankingStatus(): Promise<BankingStatus> {
    const w = await apiBanking.status(this.creds);
    return {
      connected: Boolean(w.connected),
      status: w.status || "not_connected",
      accountReference: w.accountReference ?? null,
      accountName: w.accountName ?? null,
      onboardingComplete: Boolean(w.onboardingComplete),
      paymentInitiationEnabled: Boolean(w.paymentInitiationEnabled),
      paymentInitiationRequested: Boolean(w.paymentInitiationRequested),
      paymentRequestsEnabled: Boolean(w.paymentRequestsEnabled),
      ready: Boolean(w.ready),
    };
  }

  async getBankingBalance(): Promise<BankBalance> {
    const w = await apiBanking.balance(this.creds);
    return {
      accountId: w.accountId,
      reference: w.reference ?? null,
      currency: w.currency || "EUR",
      availableBalance:
        typeof w.availableBalance === "number" ? w.availableBalance : null,
      currentBalance:
        typeof w.currentBalance === "number" ? w.currentBalance : null,
    };
  }

  async getBankingTransactions(
    query: { limit?: number; cursor?: string } = {},
  ): Promise<BankTransactionsPage> {
    const w = await apiBanking.transactions(this.creds, query);
    return {
      transactions: (w.transactions ?? []).map((tx) => ({
        id: tx.id,
        amount: typeof tx.amount === "number" ? tx.amount : 0,
        currency: tx.currency || "EUR",
        executionDate: tx.executionDate ?? null,
        valueDate: tx.valueDate ?? null,
        counterpartName: tx.counterpartName ?? null,
        counterpartReference: tx.counterpartReference ?? null,
        remittanceInformation: tx.remittanceInformation ?? null,
        remittanceInformationType: tx.remittanceInformationType ?? null,
        description: tx.description ?? null,
        createdAt: tx.createdAt ?? null,
      })),
      nextCursor: w.nextCursor ?? null,
    };
  }

  async listPendingPayouts(): Promise<Payout[]> {
    return this.collectPayouts((query) =>
      apiPayouts.listPending(this.creds, query),
    );
  }

  async listCompletedPayouts(): Promise<Payout[]> {
    return this.collectPayouts((query) =>
      apiPayouts.listCompleted(this.creds, query),
    );
  }

  async getPayout(payoutId: string): Promise<Payout> {
    return payoutFromDetailWire(await apiPayouts.get(this.creds, payoutId));
  }

  // The list endpoints are paginated (`{ payouts, total, limit, offset }`).
  // Page through to the full set so the views don't silently truncate;
  // advance by the actual rows returned (the server may cap the page size
  // below what we request), with a hard stop as a runaway guard.
  private async collectPayouts(
    fetchPage: (query: { limit: number; offset: number }) => Promise<PayoutListPageWire>,
  ): Promise<Payout[]> {
    const LIMIT = 100;
    const all: PayoutListWire[] = [];
    let offset = 0;
    for (let i = 0; i < 100; i++) {
      const page = await fetchPage({ limit: LIMIT, offset });
      const rows = page.payouts ?? [];
      all.push(...rows);
      const total = page.total ?? all.length;
      offset += rows.length;
      if (rows.length === 0 || all.length >= total) break;
    }
    return all.map(payoutFromListWire);
  }

  async getPayoutStatus(
    payoutId: string,
    opts: { redirectUrl?: string } = {},
  ): Promise<PayoutStatusDetail> {
    const res = await apiPayouts.status(this.creds, payoutId, {
      redirectUrl: opts.redirectUrl,
    });
    return {
      status: res.status,
      signingUrl: res.signingUrl ?? null,
      feeTransferPending: res.feeTransferPending ?? false,
      feeTransferTxHash: res.feeTransferTxHash ?? null,
    };
  }

  async createPayoutPayment(
    payoutId: string,
    args: { redirectUrl?: string } = {},
  ): Promise<CreatePayoutPaymentResult> {
    const res = await apiPayouts.createPayment(this.creds, payoutId, {
      redirectUrl: args.redirectUrl,
    });
    if (res.alreadyCreated) return { alreadyCreated: true };
    return {
      alreadyCreated: false,
      paymentId: res.paymentId,
      signingUrl: res.signingUrl,
    };
  }

  async burnPayout(
    payoutId: string,
    txHash: string,
    destination?: string,
  ): Promise<PayoutBurnReport> {
    const res = await apiPayouts.burn(this.creds, payoutId, txHash, destination);
    return {
      feeAmount: res.feeAmount != null ? centsToDecimal(res.feeAmount) : null,
      feeTransferTxHash: res.feeTransferTxHash ?? null,
      feeTransferPending: res.feeTransferPending ?? false,
      feeTransferError: res.feeTransferError ?? null,
    };
  }

  async feeTransfer(
    payoutId: string,
    destination: string,
  ): Promise<FeeTransferResult> {
    const res = await apiPayouts.feeTransfer(this.creds, payoutId, destination);
    return {
      feeAmount: res.feeAmount != null ? centsToDecimal(res.feeAmount) : null,
      feeTransferTxHash: res.feeTransferTxHash,
      alreadyTransferred: res.alreadyTransferred ?? false,
    };
  }

  async completePayout(payoutId: string): Promise<void> {
    await apiPayouts.complete(this.creds, payoutId);
  }

  async setPayoutFeePercentage(percent: string): Promise<void> {
    // Decimal percent → integer basis points (2.5% → 250). The local column
    // caps at 2 decimals, so the result is always integral; round anyway to
    // shed any float dust from the multiply.
    const bps = Math.round(Number(percent) * 100);
    await apiTreasury.updateFee(this.creds, bps);
  }
}

function wireToProfile(wire: {
  account: string;
  name: string;
  username: string;
  description: string;
  image: string;
  image_medium: string;
  image_small: string;
  parent?: string;
}): CitizenPayProfile {
  return {
    account: wire.account,
    name: wire.name,
    username: wire.username,
    description: wire.description,
    image: wire.image || null,
    imageMedium: wire.image_medium || null,
    imageSmall: wire.image_small || null,
    parent: wire.parent ?? null,
  };
}
