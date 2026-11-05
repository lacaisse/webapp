// SPDX-License-Identifier: AGPL-3.0-or-later

// Monthly price of hosting a fund on the official La Caisse instance, in euros,
// as shown on the subscription step and in the acceptance emails. Billing itself
// runs on Citizen Pay's side; this number is what the fund agrees to.
export const SUBSCRIPTION_MONTHLY_EUR = 40;

// Citizen Pay dashboard used when CITIZENPAY_DASHBOARD_URL is unset — same
// default as the api's DASHBOARD_BASE_URL.
export const DEFAULT_CITIZENPAY_DASHBOARD_URL = "https://my.citizenpay.xyz";
