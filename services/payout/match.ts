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

// Order statuses whose settlement is a real on-chain tx we can verify against a
// receipt and auto-match: `paid` (payment or mint), `refunded` (the original
// order — still an incoming mint), `refund` (a burn from the place). Anything
// else has no hash to check and stays in Issues until reconciled by hand.
const CONFIRMABLE_STATUSES = new Set(["paid", "refund", "refunded"]);

export function isConfirmableOrderStatus(status: string): boolean {
  return CONFIRMABLE_STATUSES.has(status);
}

// Which on-chain side an order settles against, and therefore which matcher
// resolves it:
//   • `refund`                    → a burn OUT of the place account (`total`);
//   • `refunded` / no payer account → a mint IN to the place account (`net`);
//   • paid with a payer account   → the payer's own outgoing payment (`total`).
// Refund/refunded settle against the place regardless of whether they carry a
// payer account, so status is checked before the account split. Shared by the
// dashboard's bulk Auto-match and the MCP fix tool so both route identically.
export type AutoMatchRoute = "place-burn" | "place-mint" | "payer";

export function autoMatchRoute(order: {
  status: string;
  account: string | null;
}): AutoMatchRoute {
  if (order.status === "refund") return "place-burn";
  if (order.status === "refunded" || order.account == null) return "place-mint";
  return "payer";
}

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

// =============================================================================
// Place-mint matching — terminal orders (no payer account)
// =============================================================================
// Terminal orders settle by minting the order's `net` to the place account. When
// those mints were submitted through a different bundler, our bundler can't
// resolve the recorded UserOp hash, so the order shows as unconfirmed. But the
// mint exists on-chain: we match each order to an incoming transfer on the place
// account by exact net amount on the same calendar day, consuming each transfer
// once (many orders share an amount, and one mint can only back one order), then
// record the real tx hash — which also self-heals verification.

export type PlaceMintOrder = {
  orderId: number;
  net: string; // token-unit decimal (total − fees) minted to the place
  // Anchor for the day match. Prefer createdAt (submission time); fall back to
  // completedAt since the CP orders endpoint doesn't always return created_at.
  createdAt: string | null;
  completedAt: string | null;
};

// A `refund` order settles by burning the order's `total` (fees included) from
// the place account — the on-chain mirror of a place-mint, but outgoing. (A
// `refunded` order, by contrast, is just the original order re-tagged; it still
// settled as an incoming mint of `net`, so it matches as a PlaceMintOrder.)
export type PlaceBurnOrder = {
  orderId: number;
  total: string; // token-unit decimal (fees included) burned from the place
  createdAt: string | null;
  completedAt: string | null;
};

export type PlaceMintResult = {
  matched: { orderId: number; txHash: string }[];
  unmatched: number[];
};

// Greedy same-day assignment, shared by place mints (incoming `net`) and place
// burns (outgoing `total`). For each order, among unused transfers in the given
// direction whose amount equals the order amount (± epsilon) AND that landed on
// the same UTC calendar day as the order, pick the one nearest in time (a
// tiebreak when the place saw several same-amount transfers that day). Each
// transfer is consumed once, so two orders never share one. Deterministic:
// orders processed in input order, transfers matched by pool index (safe even if
// several transfers share a hash within one tx). We match on the day rather than
// an exact minute window because the recorded settlement time and the on-chain
// block time can drift.
function assignPlaceTransfers(
  orders: {
    orderId: number;
    amount: string;
    createdAt: string | null;
    completedAt: string | null;
  }[],
  transfers: MatchTransfer[],
  direction: "in" | "out",
): PlaceMintResult {
  const pool = transfers
    .filter((t) => t.direction === direction && t.date != null)
    .map((t) => ({
      hash: t.hash,
      amount: Number(t.amount),
      time: Date.parse(t.date as string),
      day: utcDay(t.date),
    }))
    .filter((t) => !Number.isNaN(t.time) && t.day != null);

  const used = new Set<number>();
  const matched: { orderId: number; txHash: string }[] = [];
  const unmatched: number[] = [];

  for (const order of orders) {
    const anchor = order.createdAt ?? order.completedAt;
    const anchorDay = utcDay(anchor);
    const anchorTime = anchor ? Date.parse(anchor) : NaN;
    const amount = Number(order.amount);
    if (anchorDay == null || Number.isNaN(amount)) {
      unmatched.push(order.orderId);
      continue;
    }
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const c = pool[i];
      if (c.day !== anchorDay) continue;
      if (Math.abs(c.amount - amount) >= AMOUNT_EPSILON) continue;
      const delta = Number.isNaN(anchorTime) ? 0 : Math.abs(c.time - anchorTime);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      unmatched.push(order.orderId);
      continue;
    }
    used.add(bestIdx);
    matched.push({ orderId: order.orderId, txHash: pool[bestIdx].hash });
  }

  return { matched, unmatched };
}

// Match place mints: each order's `net` against an incoming transfer to the
// place, same UTC day, consumed once. Used by paid terminal orders (no payer)
// and `refunded` orders (the original order still credited the place).
export function assignPlaceMints(
  orders: PlaceMintOrder[],
  transfers: MatchTransfer[],
): PlaceMintResult {
  return assignPlaceTransfers(
    orders.map((o) => ({
      orderId: o.orderId,
      amount: o.net,
      createdAt: o.createdAt,
      completedAt: o.completedAt,
    })),
    transfers,
    "in",
  );
}

// Match place burns: each `refund` order's `total` (fees included) against an
// outgoing transfer from the place, same UTC day, consumed once.
export function assignPlaceBurns(
  orders: PlaceBurnOrder[],
  transfers: MatchTransfer[],
): PlaceMintResult {
  return assignPlaceTransfers(
    orders.map((o) => ({
      orderId: o.orderId,
      amount: o.total,
      createdAt: o.createdAt,
      completedAt: o.completedAt,
    })),
    transfers,
    "out",
  );
}
