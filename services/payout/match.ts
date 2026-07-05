// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure matching logic for the bulk "Auto-match & fix" action, kept free of any
// Alchemy / CitizenPay calls so it can be unit-tested in isolation. The server
// action (services/payout/admin-actions.ts) normalises on-chain transfers into
// `MatchTransfer`s and delegates the classification here.

// Outcome of trying to auto-fix a single order:
//   fixed       — exactly one matching payer transfer; its hash was recorded.
//   nomatch     — no payer transfer matched (leave for a manual fix).
//   ambiguous   — several transfers matched; we never guess which one settled.
//   noaccount   — bank-paid order (no payer account) — not auto-fixable here.
//   error       — recording the matched hash failed (funds already moved? no).
//   unavailable — token config missing, so we can't read on-chain transfers.
export type AutoMatchStatus =
  | "fixed"
  | "nomatch"
  | "ambiguous"
  | "noaccount"
  | "error"
  | "unavailable";

export type AutoMatchResult = {
  orderId: number;
  status: AutoMatchStatus;
  txHash?: string;
};

export type ArchiveOrdersItemResult = {
  orderId: number;
  ok: boolean;
  error?: string;
};

// A payer's on-chain transfer, normalised to the fields matching needs.
export type MatchTransfer = {
  hash: string;
  amount: string; // token-unit decimal, same scale as the order total
  date: string | null; // ISO 8601 (block timestamp), null when unknown
  direction: "in" | "out";
};

// Amounts are compared with a cent-level epsilon so token-decimal formatting
// (trailing-zero trimming, rounding) can't defeat an otherwise exact match.
const AMOUNT_EPSILON = 0.005;

// The UTC calendar day (YYYY-MM-DD) of an ISO timestamp, or null if unparseable.
// We compare in UTC so a match is deterministic regardless of the viewer's
// timezone.
export function utcDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

// Classify one order against its payer's transfers: an outgoing transfer whose
// amount equals the order total (± epsilon) and whose block landed on the same
// UTC calendar day as the order. Exactly one distinct match → fixed; none →
// nomatch; more than one distinct hash → ambiguous.
export function matchPayerTransfer(
  order: { total: string; completedAt: string | null },
  transfers: MatchTransfer[],
): { status: "fixed" | "nomatch" | "ambiguous"; txHash?: string } {
  const orderDay = utcDay(order.completedAt);
  if (orderDay == null) return { status: "nomatch" };

  const total = Number(order.total);
  if (Number.isNaN(total)) return { status: "nomatch" };

  const hashes = new Set(
    transfers
      .filter(
        (t) =>
          t.direction === "out" &&
          utcDay(t.date) === orderDay &&
          Math.abs(Number(t.amount) - total) < AMOUNT_EPSILON,
      )
      .map((t) => t.hash),
  );

  if (hashes.size === 1) return { status: "fixed", txHash: [...hashes][0] };
  if (hashes.size === 0) return { status: "nomatch" };
  return { status: "ambiguous" };
}
