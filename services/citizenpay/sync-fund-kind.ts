// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { scheduleAfterResponse } from "./after-response";
import { getCitizenPayClient, type FundCredentials } from "./client";
import type { TreasuryKind } from "./types";

// Every treasury La Caisse holds a key for is one of its caisses: a fund that
// issues cards, which the Citizen Wallet lists (api#260, `treasuries.kind`,
// docs/card-freeze.md "Fund vs token" on the api). The api defaults a new
// treasury to `token` — a plain currency places may accept, like Monerium
// EURe or a business token — and its migration 175 only marked the funds
// connected on 2026-11-06 (bxl, de-token, class, zinne). From then on La
// Caisse marks its own: on CP connect (both flows end in `consumeConnect`)
// and on every General settings save, next to the top-up URL sync, so a
// re-save also repairs a treasury that drifted. `scripts/sync-fund-kind.ts`
// replays it for every connected fund. Never `token`: La Caisse has no
// business demoting a treasury it merely holds a key for.
//
// Best-effort like the top-up URL sync: the wallet listing is a convenience,
// saving the setting (or finishing the connect) that triggered it is not — a
// CP failure is logged and reported in the result, never thrown. An api that
// predates api#260 answers 400 (none of the fields it knows is present); the
// script catches up once it is deployed. No environment guard: unlike the
// top-up URL and the webhook, nothing in the body depends on the host.

export const LA_CAISSE_TREASURY_KIND: TreasuryKind = "fund";

export type TreasuryKindSyncResult =
  | { status: "skipped"; reason: "not_connected" }
  | { status: "synced"; kind: TreasuryKind }
  | { status: "failed"; error: unknown };

/**
 * `PATCH /v2/treasury { kind: "fund" }` for the fund's treasury. No-op for a
 * fund that isn't connected to CP yet. Request paths should go through
 * `scheduleTreasuryKindSync` rather than awaiting this.
 */
export async function syncTreasuryKind(
  fund: FundCredentials,
): Promise<TreasuryKindSyncResult> {
  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
    return { status: "skipped", reason: "not_connected" };
  }
  try {
    await getCitizenPayClient(fund).setTreasuryKind(LA_CAISSE_TREASURY_KIND);
    return { status: "synced", kind: LA_CAISSE_TREASURY_KIND };
  } catch (error) {
    console.warn("[citizenpay] setTreasuryKind failed", fund.id, error);
    return { status: "failed", error };
  }
}

/**
 * Run `syncTreasuryKind` after the current response is sent (Next's
 * `after`), so a slow or hung CitizenPay never stalls a settings save or the
 * connect redirect. Call from a Server Function or Route Handler, after the
 * local write has landed. Never throws.
 */
export function scheduleTreasuryKindSync(fund: FundCredentials): void {
  scheduleAfterResponse("treasury kind sync", fund.id, () =>
    syncTreasuryKind(fund),
  );
}
