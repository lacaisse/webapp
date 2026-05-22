// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { CitizenPayProfile } from "@/services/citizenpay/types";

// Shared loaders for the token explorer. Wrapped in React's `cache()` so
// when both tables (or any future component) request the same data in the
// same render they share a single underlying call. Keep this thin — page-
// specific shaping stays in the table components.

export type FundPlace = {
  id: string;
  name: string;
  account: string | null;
};

// Primitive args (not the fund object) so `cache()` can key on identity:
// two callers in the same render with the same fund id share the call.
// Passing fresh object literals would defeat the cache.
export const getPlacesForFund = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
  ): Promise<FundPlace[]> => {
    try {
      const client = getCitizenPayClient({
        id: fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      });
      const { places } = await client.listPlaces();
      return places;
    } catch (e) {
      // CP outage shouldn't blank the explorer — degrade to no place labels.
      console.warn("[token-explorer] listPlaces failed", e);
      return [];
    }
  },
);

// Single-account profile fetch. Wrapped in `cache()` so the same address
// looked up twice in one render (e.g. once as `tx.from`, once as `tx.to`)
// only hits CP once. Lowercase the address before passing — CP keys
// profiles by raw address bytes and Alchemy already gives us lowercase.
export const getProfile = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
    account: string,
  ): Promise<CitizenPayProfile | null> => {
    try {
      const client = getCitizenPayClient({
        id: fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      });
      return await client.getProfile(account);
    } catch (e) {
      // One bad profile fetch shouldn't blank the whole transfer page.
      console.warn("[token-explorer] getProfile failed", account, e);
      return null;
    }
  },
);
