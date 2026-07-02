// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

// Low-level HTTP wrapper for the CitizenPay Treasury API (v2).
//
// One method per documented endpoint. Types mirror the wire format exactly
// — amounts are integer cents, status is lowercase, dates are ISO strings.
// Higher-level adapters in `live-client.ts` do conversions to our internal
// shapes.
//
// Spec: https://api2.citizenpay.xyz/v2/treasury/docs (openapi.yaml)
//
// Auth: `x-api-key-id` (Ethereum address) + `x-api-key` (secret). Per the
// spec, treasury identity is implicit in the API key — there's no fund-id
// in card/payout endpoints. Payment-request endpoints take an `{id}` path
// segment that's the treasury id.

export type CitizenPayApiCredentials = {
  baseUrl: string; // e.g. "https://api2.citizenpay.xyz"
  apiKeyId: string;
  apiKey: string;
};

export class CitizenPayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "CitizenPayApiError";
  }
}

// =============================================================================
// Wire types (1:1 with OpenAPI schemas)
// =============================================================================

export type CardWire = {
  serial: string;
  project?: string;
  owner?: string | null;
  pin?: string | null;
  status: "active" | "inactive" | "blocked";
  // Serial of the card this card pulls from when its own balance can't cover
  // a charge ("source card"). Omitted when no source is set.
  source_serial?: string | null;
  last_activity?: string | null;
  limits?: Record<string, unknown> | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
};

// CP returns `cards: null` (not `[]`) when the treasury has no cards, and
// can omit `pagination` entirely on empty responses. The optional/nullable
// shape here forces callers to normalise — see live-client.ts.
export type PaginatedCards = {
  cards: CardWire[] | null;
  pagination?: { page: number; limit: number; total: number; totalPages: number };
};

export type CardBalance = {
  address: string;
  balance: number; // cents
};

export type ChargeResult = { success: boolean; txHash: string };
export type TopUpResult = { success: boolean; txHash: string };
export type WithdrawResult = { success: boolean; txHash: string };

export type PlaceWire = {
  id: string;
  // CitizenPay groups places under a business. The treasury sees every
  // place individually here but the "disconnect" action is business-level
  // — so we want business_id on the wire to drive both grouping and the
  // disconnect call. Optional for the case where CP hasn't backfilled the
  // id on older rows; live-client treats missing as null.
  business_id?: string | null;
  name: string;
  slug: string;
  image?: string | null;
  account_address?: string | null;
  balance: number; // cents
  // Location data added to /v2/treasury/places. All fields are optional —
  // places can exist without a postal address (online-only, pop-up, etc.).
  address?: string | null;
  city?: string | null;
  country?: string | null;
  zip_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type OrderWire = {
  id: number;
  date: string;
  total: number;
  fees: number;
  due: number;
  [k: string]: unknown;
};

export type PaginatedOrders = {
  orders: OrderWire[];
  total: number;
  limit: number;
  offset: number;
};

// A payout as returned by the LIST endpoints (`/payouts/pending` and
// `/payouts/completed`). camelCase + integer cents, with `net` precomputed
// and the place/business labels denormalised. The list only ever carries
// the STORED status (`pending` | `complete`) — the live lifecycle (`burnt`,
// `payment-pending`) comes from `/status`. Burn tx hashes / ponto payment
// id / emails are NOT in the list shape.
export type PayoutListWire = {
  payoutId: string;
  businessId: string;
  placeId: string;
  businessName?: string | null;
  placeName?: string | null;
  placeImage?: string | null;
  status: "pending" | "complete";
  total?: number | null; // cents
  fees?: number | null; // cents
  manualDeduction?: number | null; // cents
  net?: number | null; // cents — what the merchant is paid
  tokens?: string[];
  pontoPaymentStatus?: string | null;
  // Outstanding-sweep flags: `feeTransferPending` is true on a burned payout
  // whose retained cut hasn't been swept yet; `feeTransferTxHash` is the proof
  // once it has.
  feeTransferPending?: boolean;
  feeTransferTxHash?: string | null;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
};

// The list endpoints are paginated: `{ payouts, total, limit, offset }`.
// `payouts` is null when the page is empty.
export type PayoutListPageWire = {
  payouts: PayoutListWire[] | null;
  total?: number;
  limit?: number;
  offset?: number;
};

// Single-payout detail (`GET /v2/treasury/payouts/{id}`). Same shape as a list
// row plus the manual-deduction comment.
export type PayoutDetailWire = PayoutListWire & {
  manualDeductionComment?: string | null;
};

// A draft payout: a computed summary of paid/refunded orders for one place
// that don't yet belong to a payout. Not stored — recomputed on every read.
// camelCase + integer cents on the wire. `net = total - fees`.
export type PayoutDraftWire = {
  businessId: string;
  placeId: string;
  placeName: string;
  placeImage?: string | null;
  orderCount: number;
  total: number; // cents
  fees: number; // cents
  net: number; // cents
};

// Single-place preview (the same shape as a draft row, echoing the range).
export type PayoutDraftPreviewWire = PayoutDraftWire & {
  from: string;
  to: string;
};

// 201 response from POST /v2/treasury/payouts.
export type CreatedPayoutWire = {
  payoutId: string;
  status: "pending";
  orderCount: number;
  total: number; // cents
  fees: number; // cents
  net: number; // cents
  startDate: string;
  endDate: string;
};

// An order inside a payout (snake_case; `completed_at`, not `date`).
export type PayoutOrderWire = {
  id: number;
  total: number; // cents
  fees: number; // cents
  due: number; // cents (total - fees)
  status: string; // paid | refund | refunded | correction | …
  type: string; // web | pos | terminal | …
  description?: string | null; // omitted when null
  items?: unknown[] | null; // raw line-items array
  // The orders endpoint has used both `completed_at` and a plain `date`
  // across CP revisions — accept either.
  completed_at?: string | null;
  date?: string | null;
  created_at?: string | null;
  // Settlement hash (userOp resolved via the bundler, or a plain tx). CP has
  // used both `txHash` and `tx_hash` across revisions — accept either.
  txHash?: string | null;
  tx_hash?: string | null;
  account?: string | null; // payer account; empty ⇒ "no account" fix branch
  [k: string]: unknown;
};

export type PaginatedPayoutOrders = {
  orders: PayoutOrderWire[];
  total?: number;
  limit: number;
  offset: number;
  // The place's on-chain wallet — the mint destination when reconciling an
  // unsettled order. Returned once in the envelope, not per order.
  placeAccountAddress?: string | null;
};

// Response of POST /payouts/{id}/orders/{orderId}/archive — the recomputed
// payout totals so the dashboard can update without a refetch.
export type ArchiveOrderWire = {
  success: boolean;
  payout: {
    payoutId: string;
    total: number; // cents
    fees: number; // cents
    net: number; // cents
  };
};

// Response of POST /payouts/{id}/orders (201) — the manually-created order
// plus the payout's recomputed totals (same recompute shape as archive).
export type CreatePayoutOrderWire = {
  success: boolean;
  order: PayoutOrderWire;
  payout: {
    payoutId: string;
    total: number; // cents
    fees: number; // cents
    net: number; // cents
  };
};

// Response of GET /payouts/{id}/addable-orders — existing unassigned orders
// eligible to be pulled into the pending payout, paginated, plus a `summary`
// aggregating the WHOLE window (integer cents). `orders` is null on an empty
// page. Each order reuses the payout-order wire shape (carries `date`, not
// `completed_at`, on this endpoint — handled by `payoutOrderFromWire`).
export type AddableOrdersWire = {
  orders: PayoutOrderWire[] | null;
  summary: {
    orderCount: number;
    total: number; // cents
    fees: number; // cents
    net: number; // cents
  };
  total: number;
  limit: number;
  offset: number;
};

// Response of POST /payouts/{id}/add-orders (200) — how many orders were
// assigned plus the payout's recomputed totals (archive-style recompute).
// A 422 (one or more ineligible) throws CitizenPayApiError with a body of
// `{ error, rejected: [{ id, reason }] }` — nothing is added.
export type AddOrdersWire = {
  success: boolean;
  assigned: number;
  payout: {
    payoutId: string;
    total: number; // cents
    fees: number; // cents
    net: number; // cents
  };
};

// Response of POST /payouts/{id}/manual-deduction — the recomputed totals,
// here also carrying the deduction + its comment (net = total − fees − deduction).
export type ManualDeductionWire = {
  success: boolean;
  payout: {
    payoutId: string;
    total: number; // cents
    fees: number; // cents
    manualDeduction: number; // cents
    manualDeductionComment: string | null;
    net: number; // cents
  };
};

export type PaymentRequestCreated = {
  success: boolean;
  paymentRequestId: number;
  signingUri: string;
  amount: number;
  accountAddress: string;
};

export type PaymentRequestStatus = {
  success: boolean;
  paymentRequestId: number;
  status: "pending" | "signed" | "expired";
  signed: boolean;
  expired: boolean;
  amount: number;
  orderId: number | null;
  account: string | null;
  signingUri: string | null;
};

// =============================================================================
// Request helper
// =============================================================================

async function request<T>(
  creds: CitizenPayApiCredentials,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: {
    query?: Record<string, string | number | undefined | null>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const url = new URL(path, creds.baseUrl);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers: {
        "x-api-key-id": creds.apiKeyId,
        "x-api-key": creds.apiKey,
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        accept: "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  // Drain the body once — needed for both error reporting and the success
  // path. Treat empty bodies (204, DELETE) as null.
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const fallback = `CitizenPay ${method} ${path} → ${res.status}`;
    let errMsg = fallback;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const e = (parsed as { error: unknown }).error;
      if (typeof e === "string" && e.length > 0) errMsg = e;
    }
    throw new CitizenPayApiError(errMsg, res.status, parsed);
  }

  return parsed as T;
}

// =============================================================================
// Treasury (self)
// =============================================================================
// **TODO** — guessed shape. CP hasn't documented `GET /v2/treasury` (or
// whatever the actual self-info endpoint is) yet. When confirming:
//   - Replace the path below with the documented one.
//   - Adjust `TreasuryWire` to match the real response (flat vs. nested
//     `token: { ... }` shape; field name `chain` vs `chain_id`; etc.).
//   - `syncTokenInfo` in services/citizenpay/sync.ts normalises whichever
//     shape this returns — update both together.

export type TreasuryWire = {
  // Flat shape — what the existing POST /v2/admin/treasuries body uses
  // (chain: "polygon", token_address, name, symbol, decimals, logo). The
  // reader also accepts a nested `token: { ... }` shape in case CP wraps
  // it.
  id?: string;
  business_id?: string;
  name?: string;
  // Treasury slug — the `network` query param of a card's public tap URL.
  slug?: string;
  symbol?: string;
  decimals?: number;
  chain?: string;
  token_address?: string;
  logo?: string;
  token?: {
    address?: string;
    chain?: string;
    decimals?: number;
    name?: string;
    symbol?: string;
    logo?: string;
  };
  // 4337 stack identity returned by CP per treasury. We cache these on
  // Fund so services/token/userop.ts doesn't need any env-var indirection
  // for entrypoint/factory/paymaster.
  entrypoint_address?: string;
  account_factory_address?: string;
  paymaster_address?: string;
  paymaster_type?: string;
  // Platform fee CP holds for this treasury — an echo of what we set via
  // PATCH /v2/treasury (see treasury.updateFee). Unlike the token fields,
  // the fee is canonical on OUR side; we read it back only to confirm the
  // sync landed (and to seed an initial value). Integer basis points
  // preferred (what we send); `fee_percentage` decimal accepted as a
  // fallback until CP confirms the field name.
  fee_percentage_bps?: number;
  fee_percentage?: number;
};

export const treasury = {
  get(creds: CitizenPayApiCredentials): Promise<TreasuryWire> {
    return request(creds, "GET", "/v2/treasury");
  },
  // Set the platform fee on merchant payments, in integer basis points
  // (250 = 2.5%). Treasury-level (per fund); per-business overrides are
  // future work. ⚠️ ASSUMED endpoint — CP has not shipped this yet; confirm
  // the path + body field name when they do and adjust here only.
  updateFee(
    creds: CitizenPayApiCredentials,
    feePercentageBps: number,
  ): Promise<{ success: boolean }> {
    return request(creds, "PATCH", "/v2/treasury", {
      body: { feePercentageBps },
    });
  },
};

// =============================================================================
// Profiles
// =============================================================================
// Wire shape is snake_case; the adapter in live-client.ts normalises to
// camelCase before returning to call sites.

export type ProfileWire = {
  account: string;
  description: string;
  image: string;
  image_medium: string;
  image_small: string;
  name: string;
  username: string;
  parent?: string;
};

// Batch endpoint response. `profiles` is positionally aligned with the
// request `accounts` array — same length, `null` for misses. We don't try
// to look up by `account` field; index-pairing is the documented contract.
// Max 200 accounts per request — caller is responsible for chunking.
export type BatchProfilesResponse = {
  profiles: Array<ProfileWire | null>;
};

export const PROFILES_BATCH_MAX = 200;

export const profiles = {
  // CP keys profiles by the raw address bytes — case-insensitive on their
  // side. We lowercase the path segment so the cache key the call site uses
  // matches what Alchemy returns (`from`/`to` are already lowercase) and what
  // the local AddressDirectory uses internally.
  get(creds: CitizenPayApiCredentials, account: string): Promise<ProfileWire> {
    return request(
      creds,
      "GET",
      `/v2/treasury/profiles/${encodeURIComponent(account.toLowerCase())}`,
    );
  },

  // Batch fetch — up to PROFILES_BATCH_MAX accounts per call. CP normalises
  // to lowercase server-side; we still lowercase outbound so the response
  // pairs cleanly with the call site's already-lowercased cache keys.
  // Duplicates in `accounts` are allowed — CP returns the same hit/miss at
  // each position.
  getMany(
    creds: CitizenPayApiCredentials,
    accounts: string[],
  ): Promise<BatchProfilesResponse> {
    return request(creds, "POST", "/v2/treasury/profiles", {
      body: { accounts: accounts.map((a) => a.toLowerCase()) },
    });
  },
};

// =============================================================================
// Cards
// =============================================================================

export const cards = {
  list(
    creds: CitizenPayApiCredentials,
    query: { page?: number; limit?: number; serial?: string } = {},
  ): Promise<PaginatedCards> {
    return request(creds, "GET", "/v2/treasury/cards", { query });
  },
  create(
    creds: CitizenPayApiCredentials,
    serial: string,
  ): Promise<CardWire> {
    return request(creds, "POST", "/v2/treasury/cards", { body: { serial } });
  },
  bulkCreate(
    creds: CitizenPayApiCredentials,
    serials: string[],
  ): Promise<{ created: number; conflicts: number }> {
    return request(creds, "POST", "/v2/treasury/cards/bulk", {
      body: { serials },
    });
  },
  bulkDelete(
    creds: CitizenPayApiCredentials,
    serials: string[],
  ): Promise<{ deleted: number }> {
    return request(creds, "DELETE", "/v2/treasury/cards/bulk", {
      body: { serials },
    });
  },
  get(
    creds: CitizenPayApiCredentials,
    serial: string,
  ): Promise<{ card: CardWire }> {
    return request(creds, "GET", `/v2/treasury/cards/${encodeURIComponent(serial)}`);
  },
  delete(creds: CitizenPayApiCredentials, serial: string): Promise<void> {
    return request(creds, "DELETE", `/v2/treasury/cards/${encodeURIComponent(serial)}`);
  },
  // PATCH accepts `status` and/or `source_serial` (empty string clears the
  // source) — either field alone or both in one call.
  update(
    creds: CitizenPayApiCredentials,
    serial: string,
    body: {
      status?: "active" | "inactive" | "blocked";
      source_serial?: string;
    },
  ): Promise<{ status?: string; source_serial?: string }> {
    return request(creds, "PATCH", `/v2/treasury/cards/${encodeURIComponent(serial)}`, {
      body,
    });
  },
  balance(
    creds: CitizenPayApiCredentials,
    serial: string,
  ): Promise<CardBalance> {
    return request(creds, "GET", `/v2/treasury/cards/${encodeURIComponent(serial)}/balance`);
  },
  topUp(
    creds: CitizenPayApiCredentials,
    serial: string,
    amountCents: number,
  ): Promise<TopUpResult> {
    return request(creds, "POST", `/v2/treasury/cards/${encodeURIComponent(serial)}/top-up`, {
      body: { amount: amountCents },
    });
  },
  charge(
    creds: CitizenPayApiCredentials,
    serial: string,
    args: { amountCents: number; placeId: string },
  ): Promise<ChargeResult> {
    return request(creds, "POST", `/v2/treasury/cards/${encodeURIComponent(serial)}/charge`, {
      body: { amount: args.amountCents, placeId: args.placeId },
    });
  },
  withdraw(
    creds: CitizenPayApiCredentials,
    serial: string,
    amountCents: number,
  ): Promise<WithdrawResult> {
    return request(creds, "POST", `/v2/treasury/cards/${encodeURIComponent(serial)}/withdraw`, {
      body: { amount: amountCents },
    });
  },
  // GET /cards/{serial}/tap is a 302 to a browser-facing UI — not useful from
  // server code. We surface only the URL the admin can hand to a holder.
  tapUrl(creds: CitizenPayApiCredentials, serial: string): string {
    return new URL(
      `/v2/treasury/cards/${encodeURIComponent(serial)}/tap`,
      creds.baseUrl,
    ).toString();
  },
};

// =============================================================================
// Places
// =============================================================================

export const places = {
  list(creds: CitizenPayApiCredentials): Promise<{ places: PlaceWire[] }> {
    return request(creds, "GET", "/v2/treasury/places");
  },
  orders(
    creds: CitizenPayApiCredentials,
    placeId: string,
    query: { limit?: number; offset?: number; from?: string; to?: string } = {},
  ): Promise<PaginatedOrders> {
    return request(
      creds,
      "GET",
      `/v2/treasury/places/${encodeURIComponent(placeId)}/orders`,
      { query },
    );
  },
};

// =============================================================================
// Invites (treasury → merchant business connection)
// =============================================================================
// Email-keyed invites. The treasury mints + sends, the recipient picks
// (or creates) a business on the CP dashboard. CP appends the outcome to
// our `redirect_uri` as `?token=…&status=…&treasury_id=…&business_id=…`.
// Spec: docs/TREASURY_DASHBOARD_CONNECTIONS.md.

export type InviteStatus = "pending" | "accepted" | "rejected" | "expired";

export type InviteWire = {
  token: string;
  invite_url: string;
  email: string;
  treasury_id: string;
  expires_at: string; // ISO 8601
  status: InviteStatus;
  email_sent: boolean;
  email_sent_at?: string | null;
  // Set once the recipient picks a business and accepts. Null while
  // status is pending/rejected/expired.
  accepted_business_id?: string | null;
};

export const invites = {
  // Mint + email an invite. Calling for a `(treasury, email)` pair that
  // already has a pending invite auto-rejects the previous one — the old
  // link becomes inert. Allowlist: `redirect_uri` host must match an
  // entry in CP's `TREASURY_REGISTER_ALLOWED_DOMAINS`; 403 otherwise.
  create(
    creds: CitizenPayApiCredentials,
    args: { email: string; redirectUri?: string },
  ): Promise<InviteWire> {
    return request(creds, "POST", "/v2/treasury/invites", {
      body: {
        email: args.email,
        ...(args.redirectUri ? { redirect_uri: args.redirectUri } : {}),
      },
    });
  },
  // Server-side verification of an invite's status. Called by the
  // callback route after CP's browser redirect — the query-string status
  // is a hint, not proof.
  get(creds: CitizenPayApiCredentials, token: string): Promise<InviteWire> {
    return request(
      creds,
      "GET",
      `/v2/treasury/invites/${encodeURIComponent(token)}`,
    );
  },
};

// =============================================================================
// Businesses
// =============================================================================
// Treasury-scoped business operations. The connect side (mint an invite,
// have the business owner accept on their dashboard) is documented in
// docs/TREASURY_BUSINESS_INVITE.md — only disconnect is currently wired
// here because that's the only side the treasury dashboard drives.

export const businesses = {
  // Drop the treasury → business connection. CP strips this treasury's
  // token from `businesses.tokens`, every `places.tokens` under it, and
  // every `items.tokens` (excluding the NULL "all tokens allowed" case).
  // No business-side UI is shown — the connection just disappears from
  // the business's token list.
  disconnect(
    creds: CitizenPayApiCredentials,
    businessId: string,
  ): Promise<void> {
    return request(
      creds,
      "DELETE",
      `/v2/treasury/businesses/${encodeURIComponent(businessId)}`,
    );
  },
};

// =============================================================================
// Payouts
// =============================================================================

export const payouts = {
  // List drafts — paid/refunded orders with no payout, grouped by place.
  // Optional `from`/`to` (RFC3339) narrow the window; no range = all
  // unassigned orders. Only places with positive net are returned.
  listDrafts(
    creds: CitizenPayApiCredentials,
    query: { from?: string; to?: string } = {},
  ): Promise<{ drafts: PayoutDraftWire[] | null }> {
    return request(creds, "GET", "/v2/treasury/payouts/drafts", { query });
  },
  // Preview one place over a (required) half-open [from, to) range. Returns
  // a single object (no `drafts` wrapper). 400 if from >= to.
  previewDraft(
    creds: CitizenPayApiCredentials,
    args: { placeId: string; from: string; to: string },
  ): Promise<PayoutDraftPreviewWire> {
    return request(creds, "GET", "/v2/treasury/payouts/drafts", {
      query: { placeId: args.placeId, from: args.from, to: args.to },
    });
  },
  // Materialise a pending payout — atomically claims the matching orders.
  create(
    creds: CitizenPayApiCredentials,
    body: { placeId: string; from: string; to: string },
  ): Promise<CreatedPayoutWire> {
    return request(creds, "POST", "/v2/treasury/payouts", {
      body,
      timeoutMs: 30_000,
    });
  },
  // Paginated. `payouts` is null on an empty page; callers normalise and
  // page through via limit/offset.
  listPending(
    creds: CitizenPayApiCredentials,
    query: { limit?: number; offset?: number } = {},
  ): Promise<PayoutListPageWire> {
    return request(creds, "GET", "/v2/treasury/payouts/pending", { query });
  },
  listCompleted(
    creds: CitizenPayApiCredentials,
    query: { limit?: number; offset?: number } = {},
  ): Promise<PayoutListPageWire> {
    return request(creds, "GET", "/v2/treasury/payouts/completed", { query });
  },
  // Single-payout detail. Carries the stored status (`pending` | `complete`)
  // like the list rows — the live lifecycle (`burnt` / `payment-pending`)
  // still comes from `status` below. 404 when the id isn't found.
  get(
    creds: CitizenPayApiCredentials,
    payoutId: string,
  ): Promise<PayoutDetailWire> {
    return request(
      creds,
      "GET",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}`,
    );
  },
  // Live lifecycle status (unlike the list endpoints, which only ever
  // return the stored pending/complete). `signingUrl` is included only when
  // status is `payment-pending` AND a `redirectUrl` is supplied (Ponto needs
  // a post-sign redirect — https only — to mint the signing link).
  status(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    query: { redirectUrl?: string } = {},
  ): Promise<{
    status: "pending" | "burnt" | "payment-pending" | "complete";
    signingUrl?: string | null;
    feeTransferPending?: boolean;
    feeTransferTxHash?: string | null;
  }> {
    return request(
      creds,
      "GET",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/status`,
      { query },
    );
  },
  createPayment(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    args: { redirectUrl?: string } = {},
  ): Promise<
    | { success: true; paymentId: string; signingUrl: string; alreadyCreated?: false }
    | { success: true; alreadyCreated: true }
  > {
    return request(creds, "POST", `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/payment`, {
      body: args,
      timeoutMs: 30_000,
    });
  },
  // CP no longer burns server-side: the dashboard burns the place's tokens
  // (the payout `net`) with its own minter, then reports the resulting on-chain
  // hash here. CP records it and flips the payout to `burnt`. When a
  // `destination` is supplied, CP also *attempts* to sweep the platform's
  // retained cut (`fees + manualDeduction`) to that address.
  //
  // ⚠️ This endpoint now returns 200 as soon as the BURN is recorded — even if
  // the sweep fails. A non-2xx means the burn itself failed. On 200 you MUST
  // read the body: `feeTransferPending: true` (+ `feeTransferError`) means the
  // sweep didn't run and needs a retry via `feeTransfer` below.
  burn(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    txHash: string,
    destination?: string,
  ): Promise<{
    success: boolean;
    txHash?: string;
    feeAmount?: number | null; // cents
    feeTransferTxHash?: string | null;
    feeTransferPending?: boolean;
    feeTransferError?: string | null;
  }> {
    return request(creds, "POST", `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/burn`, {
      body: destination ? { txHash, destination } : { txHash },
      timeoutMs: 30_000,
    });
  },
  // Standalone, idempotent sweep of the retained cut to `destination`. Run it
  // to retry a burn whose sweep failed, or to sweep later. Unlike `burn`, this
  // DOES surface sweep failures as HTTP status (402 insufficient, 409 not-burnt
  // / in-progress, 422 config, 503 bundler, 400 bad destination) — they throw
  // CitizenPayApiError. Idempotent: once swept, returns the hash with
  // `alreadyTransferred: true`.
  feeTransfer(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    destination: string,
  ): Promise<{
    success: boolean;
    feeAmount?: number | null; // cents
    feeTransferTxHash: string;
    alreadyTransferred?: boolean;
  }> {
    return request(creds, "POST", `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/fee-transfer`, {
      body: { destination },
      timeoutMs: 30_000,
    });
  },
  // Admin override: mark a payout `complete` without burning tokens or
  // initiating a SEPA payment (the treasury settled with the merchant another
  // way). Pure status flip, allowed from any non-complete status. 409 when the
  // payout is already complete.
  complete(
    creds: CitizenPayApiCredentials,
    payoutId: string,
  ): Promise<{ success: boolean; status?: string }> {
    return request(
      creds,
      "POST",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/complete`,
      { timeoutMs: 30_000 },
    );
  },
  orders(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<PaginatedPayoutOrders> {
    return request(
      creds,
      "GET",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/orders`,
      { query },
    );
  },
  // Record a new tx hash on an order after the dashboard mints. The server
  // re-runs its confirmation lifecycle against this hash.
  setOrderTxHash(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    orderId: number,
    txHash: string,
  ): Promise<{ success: boolean }> {
    return request(
      creds,
      "POST",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/orders/${orderId}/tx-hash`,
      { body: { txHash }, timeoutMs: 30_000 },
    );
  },
  // Manually add an order to a pending payout — for amounts that exist
  // off-CP (a bank transfer reconciled by hand, a manual adjustment, …).
  // Integer cents on the wire like every other money field. The order is
  // created payable (status=paid, type=manual) with no on-chain settlement
  // yet; the response carries the archive-style totals recompute. 400 on a
  // bad amount, 409 when the payout isn't pending.
  createOrder(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    body: { total: number; fees: number; description?: string | null },
  ): Promise<CreatePayoutOrderWire> {
    return request(
      creds,
      "POST",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/orders`,
      { body, timeoutMs: 30_000 },
    );
  },
  // Preview existing unassigned orders that could be added to a pending payout,
  // over a required RFC3339 `[from, to]` window on the order's creation date.
  // Paginated (limit max 50); `summary` aggregates the whole window. 400 on a
  // missing/invalid range, 409 when the payout isn't pending.
  addableOrders(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    query: { from: string; to: string; limit?: number; offset?: number },
  ): Promise<AddableOrdersWire> {
    return request(
      creds,
      "GET",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/addable-orders`,
      { query },
    );
  },
  // Add the selected existing orders to a pending payout. All-or-nothing: if any
  // id can't be added the whole call fails 422 (nothing applied) with a body of
  // `{ error, rejected: [{ id, reason }] }`. Returns the recomputed totals on
  // success. 409 when the payout is no longer pending.
  addOrders(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    body: { orderIds: number[] },
  ): Promise<AddOrdersWire> {
    return request(
      creds,
      "POST",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/add-orders`,
      { body, timeoutMs: 30_000 },
    );
  },
  // Set the manual deduction (cents) + comment on a payout, recomputing net.
  // Only valid while the payout is still `pending` (CP rejects otherwise).
  setManualDeduction(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    body: { manualDeduction: number; comment?: string | null },
  ): Promise<ManualDeductionWire> {
    return request(
      creds,
      "POST",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/manual-deduction`,
      { body, timeoutMs: 30_000 },
    );
  },
  // Clear a payout's manual deduction + comment (resets to 0 / null), with net
  // back to total − fees. Same `pending`-only gate as setting it.
  clearManualDeduction(
    creds: CitizenPayApiCredentials,
    payoutId: string,
  ): Promise<ManualDeductionWire> {
    return request(
      creds,
      "DELETE",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/manual-deduction`,
      { timeoutMs: 30_000 },
    );
  },
  // Archive an order out of the payout (unlink + recompute totals).
  archiveOrder(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    orderId: number,
  ): Promise<ArchiveOrderWire> {
    return request(
      creds,
      "POST",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/orders/${orderId}/archive`,
      { timeoutMs: 30_000 },
    );
  },
};

// =============================================================================
// Payments (treasury-scoped, public)
// =============================================================================

export const payments = {
  createRequest(
    creds: CitizenPayApiCredentials,
    treasuryId: string,
    args: {
      amountCents: number;
      accountAddress?: string;
      iban?: string;
      redirectUri?: string;
      orderId?: number | null;
    },
  ): Promise<PaymentRequestCreated> {
    return request(
      creds,
      "POST",
      `/v2/treasury/${encodeURIComponent(treasuryId)}/payments/request`,
      {
        body: {
          amount: args.amountCents,
          accountAddress: args.accountAddress,
          iban: args.iban,
          redirectUri: args.redirectUri,
          orderId: args.orderId ?? null,
        },
      },
    );
  },
  getRequest(
    creds: CitizenPayApiCredentials,
    treasuryId: string,
    paymentRequestId: number,
  ): Promise<PaymentRequestStatus> {
    return request(
      creds,
      "GET",
      `/v2/treasury/${encodeURIComponent(treasuryId)}/payments/request/${paymentRequestId}`,
    );
  },
  // GET /{id}/payments/request/sign is a browser redirect — emit the URL.
  signUrl(
    creds: CitizenPayApiCredentials,
    treasuryId: string,
    query: {
      bankId: string;
      redirectUri: string;
      slug?: string;
      accountAddress?: string;
      iban?: string;
      description?: string;
      amount?: number;
      topUpAmount?: number;
      orderId?: number;
    },
  ): string {
    const url = new URL(
      `/v2/treasury/${encodeURIComponent(treasuryId)}/payments/request/sign`,
      creds.baseUrl,
    );
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  },
};

// =============================================================================
// Banking (Ponto connection status)
// =============================================================================

// Whether the treasury's bank connection is active and payment initiation is
// enabled. Degrades to `{ connected:false, status:"not_connected", … }` when
// there's no business/connection yet — never errors — so the dashboard can
// render a "connect bank" step.
export type BankingStatusWire = {
  connected: boolean;
  status: string; // "active" | "not_connected" | …
  accountReference?: string | null;
  accountName?: string | null;
  onboardingComplete?: boolean;
  paymentInitiationEnabled?: boolean;
  paymentInitiationRequested?: boolean;
  paymentRequestsEnabled?: boolean;
  ready?: boolean;
};

// Account balance. Native signed decimals in the account currency (NOT
// cents) — this is external bank data, passed through as-is. Balances are
// nullable (Ponto sometimes omits them).
export type BankingBalanceWire = {
  accountId: string;
  reference?: string | null;
  currency: string;
  availableBalance?: number | null;
  currentBalance?: number | null;
};

// A bank-account transaction (Ponto). `amount < 0` = debit (money out),
// `> 0` = credit. Native decimals in `currency`.
export type BankTransactionWire = {
  id: string;
  amount: number;
  currency: string;
  executionDate?: string | null;
  valueDate?: string | null;
  counterpartName?: string | null;
  counterpartReference?: string | null;
  remittanceInformation?: string | null;
  remittanceInformationType?: string | null;
  description?: string | null;
  createdAt?: string | null;
};

// Cursor-paginated, newest-first. Pass `nextCursor` back as `?cursor=` for
// older pages; null/absent `nextCursor` means no more.
export type BankTransactionsWire = {
  transactions: BankTransactionWire[] | null;
  nextCursor?: string | null;
  limit?: number;
};

export const banking = {
  status(creds: CitizenPayApiCredentials): Promise<BankingStatusWire> {
    return request(creds, "GET", "/v2/treasury/banking/status");
  },
  balance(creds: CitizenPayApiCredentials): Promise<BankingBalanceWire> {
    return request(creds, "GET", "/v2/treasury/banking/balance");
  },
  transactions(
    creds: CitizenPayApiCredentials,
    query: { limit?: number; cursor?: string } = {},
  ): Promise<BankTransactionsWire> {
    return request(creds, "GET", "/v2/treasury/banking/transactions", {
      query,
    });
  },
};
