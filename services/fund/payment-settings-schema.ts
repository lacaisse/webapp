// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAddress, isAddress } from "viem";
import { z } from "zod";

import { euroToCents } from "./fee-schema";

// Settings → Fees (fee account, payout fee) and Settings → Citizen Pay
// (instant terminal confirmation cap): validation and conversions shared by
// the forms and the server action. Not a "use server" module, so constants
// and sync helpers may live here.
//
// Stored on Fund and pushed to Citizen Pay (citizenpay/api#277, #278):
//   feeAccountAddress     EIP-55 address | null (none: swept at payout)
//   platformPayoutFeeBps  integer basis points 0–10000 (0 = none)
//   earlyPaidMaxCents     null (Citizen Pay's default) | 0 (no limit) |
//                         1–100000 cents (the api's bound); the form offers
//                         0.01–1000.00 euros.

export const PLATFORM_FEE_MAX_BPS = 10_000;
export const EARLY_PAID_MAX_CENTS = 100_000;
// What the api applies when the fund sets nothing (TERMINAL_EARLY_PAID_MAX_CENTS
// on api#278, unless Citizen Pay configured another). Shown only when the
// api did not report the cap in force.
export const EARLY_PAID_DEFAULT_CENTS = 5_000;

// --- Fee account -----------------------------------------------------------

// The form's "None (collect at payout)" option.
export const FEE_ACCOUNT_NONE = "none";

// "none" / "" → null; anything else must be an address (any case), stored
// EIP-55. Whether it is one of the fund's OWN accounts is checked by the
// action against the server-side list (eligibleFeeAccounts).
export const feeAccountField = z
  .string()
  .trim()
  .refine((v) => v === "" || v === FEE_ACCOUNT_NONE || isAddress(v, { strict: false }), {
    error: "settings.errors.feeAccountInvalid",
  });

export function parseFeeAccount(value: string): string | null {
  const v = value.trim();
  if (v === "" || v === FEE_ACCOUNT_NONE) return null;
  return getAddress(v);
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.toLowerCase() === b.toLowerCase();
}

export type FeeAccountKind = "minter" | "account" | "safe";

// Whether the fund's main (minter) account — also the payout sweep
// destination — is offered as fee account. Kept, with a warning in the form,
// until the owner decides; set to false to drop it (the action re-derives the
// list, so it is then refused too).
export const OFFER_MAIN_ACCOUNT_AS_FEE_ACCOUNT = true;

export type FeeAccountOption = {
  address: string; // EIP-55
  name: string;
  kind: FeeAccountKind;
};

/**
 * The fund's own accounts a fee account may be: the minter account (the
 * payout sweep destination), its STANDARD token accounts and its active
 * Safes. Never a SOURCE account (it funds cards; tokens sent there would be
 * pulled onto cards) and never a merchant's account (not the fund's). The
 * minter comes first, then accounts, then Safes; duplicates (same address)
 * keep the first. Pure: the caller loads the rows, fund-scoped.
 */
export function eligibleFeeAccounts(input: {
  minterAddress: string | null;
  minterName: string;
  accounts: { name: string; address: string; kind: "STANDARD" | "SOURCE" }[];
  safes: { name: string; address: string }[];
}): FeeAccountOption[] {
  const out: FeeAccountOption[] = [];
  const seen = new Set<string>();
  const push = (address: string, name: string, kind: FeeAccountKind) => {
    if (!isAddress(address, { strict: false })) return;
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ address: getAddress(address), name, kind });
  };
  if (OFFER_MAIN_ACCOUNT_AS_FEE_ACCOUNT && input.minterAddress) {
    push(input.minterAddress, input.minterName, "minter");
  }
  for (const a of input.accounts) if (a.kind === "STANDARD") push(a.address, a.name, "account");
  for (const s of input.safes) push(s.address, s.name, "safe");
  return out;
}

// --- Payout fee (platform fee) --------------------------------------------

// Same style as the transaction rate: a percentage with up to two decimals,
// 0–100. "" = none.
const PERCENT_PATTERN = /^\d+([.,]\d{1,2})?$/;

export const platformFeeField = z
  .string()
  .trim()
  .refine((v) => v === "" || PERCENT_PATTERN.test(v), {
    error: "settings.errors.platformFeeInvalid",
  })
  .refine((v) => v === "" || !PERCENT_PATTERN.test(v) || percentToBps(v) <= PLATFORM_FEE_MAX_BPS, {
    error: "settings.errors.platformFeeTooHigh",
  });

/** "2.5" → 250, "0,75" → 75, "" → 0. String arithmetic, no float dust. */
export function percentToBps(value: string): number {
  const v = value.trim();
  if (v === "") return 0;
  if (!PERCENT_PATTERN.test(v)) throw new Error(`not a percentage: ${value}`);
  const [whole, frac = ""] = v.replace(",", ".").split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 250 → "2.5", 75 → "0.75", 0 → "" (the form's empty "no payout fee"). */
export function bpsToPercentInput(bps: number): string {
  if (!Number.isInteger(bps) || bps <= 0) return "";
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

// --- Instant terminal confirmation cap --------------------------------------

export const EARLY_PAID_MODES = ["default", "custom", "none"] as const;
export type EarlyPaidMode = (typeof EARLY_PAID_MODES)[number];

const EURO_PATTERN = /^\d{1,4}([.,]\d{1,2})?$/;

export const earlyPaidField = z
  .object({
    mode: z.enum(EARLY_PAID_MODES),
    amount: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode !== "custom") return;
    const amount = v.amount ?? "";
    if (!EURO_PATTERN.test(amount)) {
      ctx.addIssue({ code: "custom", message: "settings.errors.earlyPaidInvalid" });
      return;
    }
    const cents = euroToCents(amount);
    if (cents < 1 || cents > EARLY_PAID_MAX_CENTS) {
      ctx.addIssue({ code: "custom", message: "settings.errors.earlyPaidRange" });
    }
  });

/** The stored / wire value: null = default, 0 = no limit, else cents. */
export function earlyPaidToCents(v: z.infer<typeof earlyPaidField>): number | null {
  if (v.mode === "default") return null;
  if (v.mode === "none") return 0;
  return euroToCents(v.amount ?? "");
}

/** Stored value → the form's state. */
export function earlyPaidFromCents(cents: number | null): {
  mode: EarlyPaidMode;
  amount: string;
} {
  if (cents == null) return { mode: "default", amount: "" };
  if (cents === 0) return { mode: "none", amount: "" };
  return {
    mode: "custom",
    amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
  };
}
