// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Address } from "viem";

import { formatTokenAmount } from "@/services/alchemy/format";

// Balances the Accounts pages can show next to the fund token. Accounts and
// Safes can hold more than the fund's own token — gas (the chain's native
// coin) and euro stablecoins are the common ones. Each fund opts in per token
// (Fund.showNativeBalance / Fund.showEureBalance, Settings → Token); a chain
// without an entry here shows nothing extra.
//
// Besides these built-ins, a fund can register any other ERC-20 on its chain
// (FundDisplayToken, Settings → Token → Custom tokens); those carry the key
// `custom:<lowercased address>` and are appended after the built-ins by
// services/token/display-tokens.ts::getDisplayTokens.
//
// Pure module (no server-only): the settings form and the pages share it.

export type BuiltInExtraTokenKey = "native" | "eure";
export type CustomTokenKey = `custom:${string}`;
export type ExtraTokenKey = BuiltInExtraTokenKey | CustomTokenKey;

const CUSTOM_PREFIX = "custom:";
const CUSTOM_KEY_RE = /^custom:0x[0-9a-f]{40}$/;

/** Key of a fund-registered token: `custom:<lowercased address>`. */
export function customTokenKey(address: string): CustomTokenKey {
  return `${CUSTOM_PREFIX}${address.toLowerCase()}`;
}

/** True for a well-formed custom key (lowercase 0x + 40 hex). */
export function isCustomTokenKey(key: string): key is CustomTokenKey {
  return CUSTOM_KEY_RE.test(key);
}

/** The lowercased address inside a custom key. */
export function customTokenAddress(key: CustomTokenKey): string {
  return key.slice(CUSTOM_PREFIX.length);
}

export type ExtraToken = {
  key: ExtraTokenKey;
  symbol: string;
  decimals: number;
  address: Address | null; // null = the chain's native coin
};

export const EXTRA_TOKENS_BY_CHAIN: Record<number, ExtraToken[]> = {
  // Gnosis Chain.
  100: [
    { key: "native", symbol: "xDAI", decimals: 18, address: null },
    {
      // Monerium EURe v2 (symbol() = "EURe", decimals() = 18, checked on
      // chain 2026-10-29).
      key: "eure",
      symbol: "EURe",
      decimals: 18,
      address: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430",
    },
  ],
};

export type BalanceDisplaySettings = {
  tokenChainId: number;
  showNativeBalance: boolean;
  showEureBalance: boolean;
};

/**
 * The built-in extra tokens this fund chose to show, in registry order. The
 * fund's custom tokens come on top through getDisplayTokens (server-only).
 */
export function enabledExtraTokens(fund: BalanceDisplaySettings): ExtraToken[] {
  const tokens = EXTRA_TOKENS_BY_CHAIN[fund.tokenChainId] ?? [];
  return tokens.filter((tok) =>
    tok.key === "native" ? fund.showNativeBalance : fund.showEureBalance,
  );
}

// 18-decimal amounts would otherwise print every wei ("0.049871234…").
const DISPLAY_FRACTION_DIGITS = 4;

/**
 * Raw (hex or decimal) amount → human string, truncated (never rounded up)
 * to 4 decimals with trailing zeros dropped: "12.3456", "4.5", "0".
 */
export function formatExtraAmount(raw: string, decimals: number): string {
  const full = formatTokenAmount(raw, decimals);
  const dot = full.indexOf(".");
  if (dot === -1) return full;
  const frac = full.slice(dot + 1, dot + 1 + DISPLAY_FRACTION_DIGITS).replace(/0+$/, "");
  const whole = full.slice(0, dot);
  return frac ? `${whole}.${frac}` : whole;
}
