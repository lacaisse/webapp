// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreasuryPaymentSettings, TreasuryPaymentSettingsUpdate } from "./types";

// Pure rules of the payment settings (fee account, platform payout fee,
// instant terminal confirmation cap — citizenpay/api#277, #278) against what
// Citizen Pay reports: equality, defaults, and what the settings page shows.
// No I/O, unit-tested. The apply step is sync-payment-settings.ts.

export type PaymentSettingField =
  | "feeAccountAddress"
  | "platformPayoutFeeBps"
  | "earlyPaidMaxCents";

export const PAYMENT_SETTING_FIELDS: readonly PaymentSettingField[] = [
  "feeAccountAddress",
  "platformPayoutFeeBps",
  "earlyPaidMaxCents",
];

// The Fund column holding "Citizen Pay confirmed this value" per setting.
export const SYNCED_COLUMN = {
  feeAccountAddress: "feeAccountSynced",
  platformPayoutFeeBps: "platformPayoutFeeSynced",
  earlyPaidMaxCents: "earlyPaidMaxCentsSynced",
} as const satisfies Record<PaymentSettingField, string>;

// A setting's value as La Caisse stores it (Fund columns):
//   feeAccountAddress     string (EIP-55) | null
//   platformPayoutFeeBps  number
//   earlyPaidMaxCents     number | null
export type PaymentSettingValue = string | number | null;

// The value that changes nothing: what an api predating the setting applies.
export function isDefaultValue(field: PaymentSettingField, value: PaymentSettingValue): boolean {
  return field === "platformPayoutFeeBps" ? value === 0 : value === null;
}

/** What CP reports for a field: undefined = not reported (not supported). */
export function remoteValue(
  remote: TreasuryPaymentSettings,
  field: PaymentSettingField,
): PaymentSettingValue | undefined {
  switch (field) {
    case "feeAccountAddress":
      return remote.feeAccountAddress;
    case "platformPayoutFeeBps":
      return remote.payoutFeePercentageBps;
    case "earlyPaidMaxCents":
      return remote.earlyPaidMaxCents;
  }
}

/** Same setting value? Addresses compare case-insensitively. */
export function sameValue(
  field: PaymentSettingField,
  a: PaymentSettingValue | undefined,
  b: PaymentSettingValue | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  if (field === "feeAccountAddress" && typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** The one-key PATCH body for a field. */
export function updateFor(
  field: PaymentSettingField,
  value: PaymentSettingValue,
): TreasuryPaymentSettingsUpdate {
  switch (field) {
    case "feeAccountAddress":
      return { feeAccountAddress: value as string | null };
    case "platformPayoutFeeBps":
      return { payoutFeePercentageBps: value as number };
    case "earlyPaidMaxCents":
      return { earlyPaidMaxCents: value as number | null };
  }
}

// What the settings page says about one setting, from La Caisse's value and
// Citizen Pay's live answer (`GET /v2/treasury`, read on every view of the
// tab when the fund is connected):
//   inSync          CP applies La Caisse's value (or both are the default on
//                   an api that does not know the setting): nothing to say;
//   drift           CP reports another value — set elsewhere (a raw PATCH
//                   during the api rollout), a previous treasury, or a save
//                   that did not reach it. Offer "Apply La Caisse's value"
//                   and "Use Citizen Pay's value";
//   notYetSupported La Caisse holds a non-default value the api does not know
//                   yet: not applied; "Apply now" waits for the api;
//   unreadable      the live value could not be read;
//   notConnected    La Caisse holds a non-default value and the fund is not
//                   connected to Citizen Pay.
export type PaymentSettingView =
  | { state: "inSync" }
  | { state: "drift"; remote: PaymentSettingValue }
  | { state: "notYetSupported" }
  | { state: "unreadable" }
  | { state: "notConnected" };

export function viewPaymentSetting(
  field: PaymentSettingField,
  local: PaymentSettingValue,
  // null = fund not connected; "error" = the read failed.
  remote: TreasuryPaymentSettings | "error" | null,
): PaymentSettingView {
  if (remote === null) {
    return isDefaultValue(field, local) ? { state: "inSync" } : { state: "notConnected" };
  }
  if (remote === "error") return { state: "unreadable" };
  const r = remoteValue(remote, field);
  if (r === undefined) {
    return isDefaultValue(field, local) ? { state: "inSync" } : { state: "notYetSupported" };
  }
  return sameValue(field, local, r) ? { state: "inSync" } : { state: "drift", remote: r };
}
