// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { CitizenPayApiError } from "./api";
import type { CitizenPayClient } from "./client-interface";
import {
  remoteValue,
  sameValue,
  updateFor,
  type PaymentSettingField,
  type PaymentSettingValue,
} from "./payment-settings-rules";

// Apply ONE payment setting (fee account, platform payout fee — api#277;
// instant terminal confirmation cap — api#278) on Citizen Pay, and say what
// happened. Only ever called from an explicit action on the setting's own
// settings tab (its form's save, or its "Apply" button): nothing pushes these
// in the background, so a value saved while the api lacked support never
// goes live through an unrelated save.
//
//   1. GET /v2/treasury: support (the field is present) and the value CP
//      applies now. Absent = the api does not know the setting yet: nothing
//      is sent.
//   2. Equal to the wanted value: nothing to send (case-insensitive address).
//   3. PATCH with that one key only.
//   4. GET again to confirm: only a read that holds exactly the wanted value
//      counts as applied (a PATCH echo can be overtaken by a concurrent save).
//
// Errors: the cap's 409 is the api's documented "column missing" answer (=
// not supported yet); a 409 on the other two, or any 400, is the api refusing
// the value — its message is returned with the value CP still applies, so the
// caller can put the control back on it. Never re-sent automatically.
//
// Time bound: three calls in sequence, each capped at
// PAYMENT_SETTINGS_TIMEOUT_MS (5 s) by the api client: at most about 15 s.
// Several settings are applied concurrently, so a save stays within that.

export type ApplyPaymentSettingOutcome =
  | { kind: "applied"; changed: boolean } // CP confirmed the value; changed = we PATCHed
  | { kind: "notSupported" } // this api does not know the setting yet
  | { kind: "refused"; message: string; confirmed: PaymentSettingValue } // CP still applies `confirmed`
  | { kind: "failed" }; // unreachable / unconfirmed: try again

export async function applyPaymentSetting(
  client: Pick<CitizenPayClient, "getTreasuryPaymentSettings" | "setTreasuryPaymentSettings">,
  field: PaymentSettingField,
  wanted: PaymentSettingValue,
  log: { fundId: string },
): Promise<ApplyPaymentSettingOutcome> {
  let before: PaymentSettingValue | undefined;
  try {
    before = remoteValue(await client.getTreasuryPaymentSettings(), field);
  } catch (e) {
    console.warn("[citizenpay] payment settings read failed", log.fundId, field, e);
    return { kind: "failed" };
  }
  if (before === undefined) return { kind: "notSupported" };
  if (sameValue(field, before, wanted)) return { kind: "applied", changed: false };

  try {
    await client.setTreasuryPaymentSettings(updateFor(field, wanted));
  } catch (e) {
    if (e instanceof CitizenPayApiError && e.status === 409 && field === "earlyPaidMaxCents") {
      return { kind: "notSupported" };
    }
    if (e instanceof CitizenPayApiError && (e.status === 400 || e.status === 409)) {
      console.warn("[citizenpay] payment setting refused", log.fundId, field, e.message);
      return { kind: "refused", message: e.message, confirmed: before };
    }
    console.warn("[citizenpay] payment setting push failed", log.fundId, field, e);
    return { kind: "failed" };
  }

  try {
    const after = remoteValue(await client.getTreasuryPaymentSettings(), field);
    if (sameValue(field, after, wanted)) return { kind: "applied", changed: true };
    console.warn("[citizenpay] payment setting not confirmed by the read-back", log.fundId, {
      field,
      after,
    });
  } catch (e) {
    console.warn("[citizenpay] payment settings read-back failed", log.fundId, field, e);
  }
  return { kind: "failed" };
}
