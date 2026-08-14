// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type {
  Payout,
  PayoutDraft,
  PayoutOrder,
  PayoutStatusDetail,
} from "@/services/citizenpay/types";
import { loadAllPayoutOrders } from "@/services/payout/operations";

// Loaders for the Payments → Payouts views. Each is wrapped in React's
// `cache()` so repeat reads in one render pass share a single CP round-trip,
// and each degrades to an empty result + `error: true` so a CP outage shows
// an inline notice instead of reading as "nothing here". Primitive args (not
// the fund object) so `cache()` keys on identity.

export type DraftsData = { drafts: PayoutDraft[]; error: boolean };
export type PayoutsListData = { payouts: Payout[]; error: boolean };

function client(
  fundId: string,
  citizenPayApiKeyId: string | null,
  citizenPayApiKeyEnc: string | null,
) {
  return getCitizenPayClient({
    id: fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
  });
}

export const getPayoutDrafts = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
  ): Promise<DraftsData> => {
    try {
      const drafts = await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).listPayoutDrafts();
      return { drafts, error: false };
    } catch (e) {
      console.warn("[payments] listPayoutDrafts failed", e);
      return { drafts: [], error: true };
    }
  },
);

export const getPendingPayouts = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
  ): Promise<PayoutsListData> => {
    try {
      const payouts = await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).listPendingPayouts();
      return { payouts, error: false };
    } catch (e) {
      console.warn("[payments] listPendingPayouts failed", e);
      return { payouts: [], error: true };
    }
  },
);

export const getCompletedPayouts = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
  ): Promise<PayoutsListData> => {
    try {
      const payouts = await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).listCompletedPayouts();
      return { payouts, error: false };
    } catch (e) {
      console.warn("[payments] listCompletedPayouts failed", e);
      return { payouts: [], error: true };
    }
  },
);

// Single-payout summary for the detail header — total / fees / net / manual
// deduction. Backed by GET /v2/treasury/payouts/{id}. Returns null on a miss
// (404) or CP error so the page falls through to notFound().
export const getPayoutSummary = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
    payoutId: string,
  ): Promise<Payout | null> => {
    try {
      return await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).getPayout(payoutId);
    } catch (e) {
      console.warn("[payments] getPayout failed", e);
      return null;
    }
  },
);

// Live lifecycle status for the detail header. Reading /status self-heals
// (CP finalises a signed payout + sends the email), so loading the page
// nudges settlement forward. Degrades to null on error.
export const getPayoutLiveStatus = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
    payoutId: string,
    redirectUrl: string,
  ): Promise<PayoutStatusDetail | null> => {
    try {
      return await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).getPayoutStatus(payoutId, { redirectUrl });
    } catch (e) {
      console.warn("[payments] getPayoutStatus failed", e);
      return null;
    }
  },
);

export type AllPayoutOrdersData = {
  orders: PayoutOrder[];
  placeAccountAddress: string | null;
  truncated: boolean;
  error: boolean;
};

// All of a payout's orders, paged through to completion. Needed to partition
// orders into confirmed vs. issues for the detail tabs — the server doesn't
// expose that split, so the dashboard fetches the lot and classifies.
export const getAllPayoutOrders = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
    payoutId: string,
  ): Promise<AllPayoutOrdersData> => {
    try {
      const loaded = await loadAllPayoutOrders(
        client(fundId, citizenPayApiKeyId, citizenPayApiKeyEnc),
        payoutId,
      );
      return { ...loaded, error: false };
    } catch (e) {
      console.warn("[payments] getAllPayoutOrders failed", e);
      return {
        orders: [],
        placeAccountAddress: null,
        truncated: false,
        error: true,
      };
    }
  },
);

// The place's live on-chain token balance — so the operator can tell whether
// the place's account holds enough to cover the burn (`net`). Resolves the
// place's wallet via CP `listPlaces`, then reads the chain via Alchemy.
// Returns a Decimal string in token units, or null when we can't determine it
// (no token configured, no place account, RPC/CP error).
export const getPlaceOnChainBalance = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
    placeId: string,
    tokenAddress: string | null,
    tokenChainId: number | null,
    tokenDecimals: number | null,
  ): Promise<string | null> => {
    if (!tokenAddress || tokenChainId == null) return null;
    try {
      const { places } = await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).listPlaces();
      const account = places.find((p) => p.id === placeId)?.account;
      if (!account) return null;
      const [balance] = await getBalances({
        chainId: tokenChainId,
        contractAddress: tokenAddress,
        addresses: [account],
      });
      if (!balance) return null;
      return formatTokenAmount(balance.rawBalance, tokenDecimals);
    } catch (e) {
      console.warn("[payments] getPlaceOnChainBalance failed", e);
      return null;
    }
  },
);
