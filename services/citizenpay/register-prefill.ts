// SPDX-License-Identifier: AGPL-3.0-or-later

// Prefill for CP's treasury-registration page (Flow 1). Pure module — no
// Prisma, no Next — so it can be unit-tested and imported from anywhere.
//
// CP stores every query param of GET /v2/treasury/register except
// `redirect_uri` as JSON prefill and the dashboard's /treasury/register
// page reads `name`, `symbol`, `decimals`, `chain`, `token_address`,
// `slug`, `fee_percentage`, `logo`, `color`, `key_name` back out of it.
// We send only the four we know: the token name/symbol the fund admin
// already typed in La Caisse, 6 decimals (the only setup services/token/*
// mints and burns on), and the Gnosis chain.

// `chain` is CP's `chain_prefix` for the chains row. The dashboard snaps an
// unknown prefix back to its first configured chain, so a wrong value
// degrades to "the admin picks the chain" rather than an error. Overridable
// per deployment for a staging api whose chains table is keyed differently.
export const DEFAULT_REGISTER_CHAIN_PREFIX = "Gnosis";
export const REGISTER_TOKEN_DECIMALS = 6;

export type RegistrationPrefill = {
  /** Token / treasury name shown on CP's register form. */
  name: string;
  /** Token symbol; omitted from the query when the fund hasn't set one. */
  symbol?: string | null;
};

/**
 * The prefill query params for Flow 1, as `key → value`. Empty / blank
 * name and symbol are left out so CP's form shows its own placeholder
 * instead of a whitespace value.
 */
export function buildRegistrationPrefill(
  prefill: RegistrationPrefill,
  chainPrefix: string = process.env.CITIZENPAY_REGISTER_CHAIN ||
    DEFAULT_REGISTER_CHAIN_PREFIX,
): Record<string, string> {
  const out: Record<string, string> = {};
  const name = prefill.name.trim();
  if (name) out.name = name;
  const symbol = prefill.symbol?.trim();
  if (symbol) out.symbol = symbol;
  out.decimals = String(REGISTER_TOKEN_DECIMALS);
  out.chain = chainPrefix;
  return out;
}
