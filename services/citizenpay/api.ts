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

export type PayoutWire = {
  id: string;
  business_id: string;
  place_id: string;
  start_date: string;
  end_date: string;
  total_amount: number; // cents
  status: "pending" | "burnt" | "payment-pending" | "complete";
  burn_tx_hashes?: Record<string, unknown> | null;
  ponto_payment_id?: string | null;
  ponto_payment_status?: string | null;
  tokens: string[];
  total_fees: number;
  email_sent_at?: string | null;
  email_recipient?: string | null;
  email_id?: string | null;
  manual_deduction: number;
  manual_deduction_comment?: string | null;
  created_at: string;
  updated_at: string;
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
};

export const treasury = {
  get(creds: CitizenPayApiCredentials): Promise<TreasuryWire> {
    return request(creds, "GET", "/v2/treasury");
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
  updateStatus(
    creds: CitizenPayApiCredentials,
    serial: string,
    status: "active" | "inactive" | "blocked",
  ): Promise<{ status: string }> {
    return request(creds, "PATCH", `/v2/treasury/cards/${encodeURIComponent(serial)}`, {
      body: { status },
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
  listPending(creds: CitizenPayApiCredentials): Promise<PayoutWire[]> {
    return request(creds, "GET", "/v2/treasury/payouts/pending");
  },
  listCompleted(creds: CitizenPayApiCredentials): Promise<PayoutWire[]> {
    return request(creds, "GET", "/v2/treasury/payouts/completed");
  },
  status(
    creds: CitizenPayApiCredentials,
    payoutId: string,
  ): Promise<{ status: PayoutWire["status"] }> {
    return request(creds, "GET", `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/status`);
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
  burn(
    creds: CitizenPayApiCredentials,
    payoutId: string,
  ): Promise<{ success: boolean; txHash: string }> {
    return request(creds, "POST", `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/burn`, {
      timeoutMs: 30_000,
    });
  },
  orders(
    creds: CitizenPayApiCredentials,
    payoutId: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<PaginatedOrders> {
    return request(
      creds,
      "GET",
      `/v2/treasury/payouts/${encodeURIComponent(payoutId)}/orders`,
      { query },
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
