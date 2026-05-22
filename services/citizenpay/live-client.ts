// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";

import {
  businesses as apiBusinesses,
  cards as apiCards,
  invites as apiInvites,
  places as apiPlaces,
  profiles as apiProfiles,
  PROFILES_BATCH_MAX,
  type CitizenPayApiCredentials,
  CitizenPayApiError,
  type InviteWire,
  type PaginatedCards,
} from "./api";
import type { CitizenPayClient } from "./client-interface";
import type {
  CardOperationInput,
  CardOperationResult,
  CardStatus,
  CitizenPayCard,
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
//   - `listBankTransactions`: the v2 API has no equivalent. We return empty
//     and log so the cron doesn't crash. The intended replacement is the
//     `/{id}/payments/request` flow (member-initiated PSD2 SCA), which is
//     a different shape and needs a UI redesign.

function toCents(decimal: string | Prisma.Decimal): number {
  const d = decimal instanceof Prisma.Decimal ? decimal : new Prisma.Decimal(decimal);
  // Round to 2dp first to avoid floating-point hex from a previously-stored
  // value like "1.234999..." sneaking through.
  return d.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
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
  created_at: string;
  last_activity?: string | null;
}): CitizenPayCard {
  return {
    serialNumber: w.serial,
    status: statusFromWire(w.status),
    owner: w.owner ?? null,
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

  async blockCard(serialNumber: string): Promise<void> {
    try {
      await apiCards.updateStatus(this.creds, serialNumber, "blocked");
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
      await apiCards.updateStatus(this.creds, serialNumber, "active");
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

  async listBankTransactions(
    input: ListBankTransactionsInput,
  ): Promise<ListBankTransactionsResult> {
    // The v2 API doesn't expose bank movements. The bank-sync cron is a
    // no-op against the live client until we wire the
    // `/{id}/payments/request` flow (or another bank-feed source).
    console.warn(
      "[citizenpay] listBankTransactions is not supported by the v2 API — returning empty",
      { fundCitizenPayId: input.fundCitizenPayId, since: input.since },
    );
    return { transactions: [] };
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
      await apiCards.updateStatus(this.creds, serialNumber, wire);
    } catch (e) {
      if (e instanceof CitizenPayApiError && e.status === 409) return;
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
