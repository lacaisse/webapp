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
// mints and burns on), and the Gnosis chain prefix.

// `chain` is CP's `chain_prefix` for the chains row — in production the
// Gnosis row (chain_id 100, chain_name "Gnosis") has chain_prefix "100".
// This must match exactly: the dashboard snaps an unknown prefix back to its
// FIRST configured chain, which is the virtual "Citizen Pay" chain, so a
// wrong value silently selects the wrong chain. Overridable per deployment
// for an api whose chains table is keyed differently.
export const DEFAULT_REGISTER_CHAIN_PREFIX = "100";
export const REGISTER_TOKEN_DECIMALS = 6;

export type RegistrationPrefill = {
  /** Token / treasury name shown on CP's register form. */
  name: string;
  /** Token symbol; omitted from the query when the fund hasn't set one. */
  symbol?: string | null;
  /** Label for the first API key, shown in CP's audit log. */
  keyName?: string | null;
};

// CP's token deploy route requires ^[A-Z0-9]{2,8}$.
const SYMBOL_MAX = 8;
const SYMBOL_MIN = 2;

/**
 * Coerce a fund's free-text symbol into what CP's deploy route accepts:
 * upper-case, A-Z0-9 only, at most 8 characters. Null when fewer than 2
 * characters survive — better to leave CP's field empty than to pre-fill
 * something the admin can't submit.
 */
export function normaliseSymbol(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, SYMBOL_MAX);
  return cleaned.length >= SYMBOL_MIN ? cleaned : null;
}

/**
 * The prefill query params for Flow 1, as `key → value`. Empty / blank
 * name, symbol and key name are left out so CP's form shows its own
 * placeholder instead of a whitespace value.
 */
export function buildRegistrationPrefill(
  prefill: RegistrationPrefill,
  chainPrefix: string = process.env.CITIZENPAY_REGISTER_CHAIN ||
    DEFAULT_REGISTER_CHAIN_PREFIX,
): Record<string, string> {
  const out: Record<string, string> = {};
  const name = prefill.name.trim();
  if (name) out.name = name;
  const symbol = normaliseSymbol(prefill.symbol);
  if (symbol) out.symbol = symbol;
  out.decimals = String(REGISTER_TOKEN_DECIMALS);
  out.chain = chainPrefix;
  const keyName = prefill.keyName?.trim();
  if (keyName) out.key_name = keyName;
  return out;
}
