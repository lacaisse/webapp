// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared types for the CitizenPay client. Kept in a plain module (no
// `server-only`) so types can be referenced from anywhere if needed; the
// client itself enforces server-only.

export type CardStatus = "ACTIVE" | "INACTIVE" | "BLOCKED";

export type RegisterCardInput = {
  serialNumber: string; // NFC UUID
  fundId: string; // our internal fund id
  fundCitizenPayId: string | null; // CP's identifier for this fund (Fund.citizenPayFundId)
  holderName?: string;
};

export type RegisteredCard = {
  serialNumber: string;
  account: string; // on-chain wallet address
  status: CardStatus;
};

export type SubmitMintInput = {
  fundCitizenPayId: string | null;
  toAccount: string; // recipient wallet (typically a primary card's account)
  amount: string; // Decimal as a string, preserved through the API
  reference?: string; // free-text reference for audit (op id, member id, etc.)
};

export type SubmittedOperation = {
  txHash: string;
  status: "PENDING";
};

export type OperationStatus = "PENDING" | "CONFIRMED" | "FAILED";

export type OperationStatusResult = {
  txHash: string;
  status: OperationStatus;
  errorMessage?: string;
};

export type BankTransactionDirection = "INCOMING" | "OUTGOING";

// Bank movement as reported by CitizenPay. `externalId` is CP's stable
// identifier — we use it for idempotency on our local mirror. Optional
// fields reflect what the bank reports varies by counterpart and transfer
// type; we keep the raw payload too for debugging and re-matching.
export type BankTransactionPayload = {
  externalId: string;
  direction: BankTransactionDirection;
  amount: string; // Decimal as a string
  currency: string;
  occurredAt: string; // ISO 8601
  counterpartName?: string | null;
  counterpartIban?: string | null;
  counterpartReference?: string | null;
  remittanceInfo?: string | null;
  rawData?: unknown;
};

export type ListBankTransactionsInput = {
  fundCitizenPayId: string;
  /** ISO 8601. Returns transactions occurring strictly after this time. */
  since?: string;
};

export type ListBankTransactionsResult = {
  transactions: BankTransactionPayload[];
};

// One cursor-paginated page of ingest-shaped bank transactions (newest-first).
// Used by the manual full-sync, which walks pages client-side so each request
// stays short. `nextCursor === null` means there are no older pages.
// `fetched` is the raw count CP returned for this page (before we drop undated
// rows) — `fetched === 0` is a reliable end-of-feed signal even if a stale
// cursor is still present. Note `transactions.length` can be smaller than
// `fetched` (undated rows dropped) and `fetched` can be smaller than the
// requested limit on a non-final page (the server may cap page size), so
// neither length is a safe end signal on its own.
export type BankTransactionPayloadPage = {
  transactions: BankTransactionPayload[];
  nextCursor: string | null;
  fetched: number;
};

// A merchant location ("place") as known to CitizenPay. CP's wire shape uses
// snake_case keys and integer cents; we surface a normalised camelCase shape
// here and let the live adapter convert. `account` may be null when CP
// hasn't issued an on-chain wallet for the place yet. `balanceCents` is
// CP's on-chain balance snapshot, in cents — null if CP returned no
// number (e.g. when `account` is null).
//
// `businessId` is CP's parent grouping (a business has 1..N places). Used
// by the merchant sync to populate `Merchant.citizenPayBusinessId` and by
// the disconnect flow to enumerate sibling places that will be torn down
// together. Null if CP didn't include it on the wire.
//
// Location fields are individually nullable — places can exist on CP
// without a postal address (online-only, pop-up, etc.). The merchant
// sync mirrors these onto the Merchant row when present, never overwriting
// with null.
export type CitizenPayPlace = {
  id: string;
  businessId: string | null;
  name: string;
  account: string | null;
  balanceCents: number | null;
  address: string | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type ListPlacesResult = {
  places: CitizenPayPlace[];
};

// An invite minted via POST /v2/treasury/invites. The status enum is the
// same one CP exposes on /v2/treasury/invites/{token} — used both as the
// mint response and by the callback verifier.
export type CitizenPayInviteStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired";

export type CitizenPayInvite = {
  token: string;
  inviteUrl: string;
  email: string;
  expiresAt: string; // ISO 8601
  status: CitizenPayInviteStatus;
  emailSent: boolean;
  emailSentAt: string | null;
  // Set once the recipient picks a business and accepts. Null while
  // status is pending/rejected/expired.
  acceptedBusinessId: string | null;
};

// CitizenPay-hosted profile for an on-chain account. Used by the token
// explorer to label external wallets (people who aren't local cards/places).
// Image URLs are optional — CP returns empty strings when unset; we
// normalise those to null at the adapter layer.
export type CitizenPayProfile = {
  account: string;
  name: string;
  username: string;
  description: string;
  image: string | null;
  imageMedium: string | null;
  imageSmall: string | null;
  parent: string | null;
};

// Card-scoped operations against the v2 REST API. Distinct from
// `submitMint` (which is the legacy address-based mint shim that will be
// replaced by the bundler-based flow). Top-up and withdraw target a
// specific card by serial — they're what the admin Cards UI invokes.
export type CardOperationInput = {
  serialNumber: string;
  amount: string; // Decimal as a string; converted to cents at the adapter
};

export type CardOperationResult = {
  txHash: string;
};

// Snapshot of a card as CitizenPay knows it — used by the cards
// reconciliation view to surface drift against the local Card rows.
export type CitizenPayCard = {
  serialNumber: string;
  status: CardStatus;
  owner: string | null;
  createdAt: string; // ISO 8601
  lastActivity: string | null;
};

// Detailed read for a single card, including its on-chain account address.
// `account` is null when CP hasn't issued a wallet yet (rare — usually
// happens between card create and the first balance call).
export type CitizenPayCardDetail = CitizenPayCard & {
  account: string | null;
};

export type ListCardsInput = {
  /** 1-indexed page, default 1. */
  page?: number;
  /** Page size, max 100. */
  limit?: number;
};

export type ListCardsResult = {
  cards: CitizenPayCard[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

// =============================================================================
// Merchant payouts (settlement)
// =============================================================================
// CitizenPay aggregates the token payments a merchant place received over a
// period into a "payout" the treasury then settles in two steps:
//   1. createPayoutPayment → the admin signs a SEPA transfer to the merchant
//      (CP returns a signing URL the admin opens at their bank).
//   2. burnPayout → the matching tokens are burned on-chain once the fiat
//      leg is paid.
// Lifecycle: pending → payment-pending → burnt → complete.

export type PayoutStatus = "pending" | "payment-pending" | "burnt" | "complete";

// Live status from `GET /payouts/{id}/status`. `signingUrl` is present only
// while `payment-pending` (the Ponto signing link) — null otherwise.
export type PayoutStatusDetail = {
  status: PayoutStatus;
  signingUrl: string | null;
};

// Normalised view of CP's `PayoutWire`. Cents-on-the-wire amounts are
// surfaced as Decimal strings (EUR) so the UI formats them like every other
// money value in the app. `net = totalAmount - totalFees - manualDeduction`.
export type Payout = {
  id: string;
  businessId: string;
  placeId: string;
  // Denormalised labels from the list endpoints; null on older rows.
  businessName: string | null;
  placeName: string | null;
  placeImage: string | null;
  startDate: string; // ISO 8601 — start of the settlement period
  endDate: string; // ISO 8601 — end of the settlement period
  totalAmount: string; // Decimal string, EUR — gross tokens collected
  totalFees: string; // Decimal string, EUR — platform fees
  manualDeduction: string; // Decimal string, EUR — admin adjustment
  manualDeductionComment: string | null;
  net: string; // Decimal string, EUR — what the merchant is paid
  status: PayoutStatus;
  // On-chain burn tx hashes once the burn step runs (CP returns one per
  // token batch). Empty until burnt.
  burnTxHashes: string[];
  pontoPaymentId: string | null;
  pontoPaymentStatus: string | null;
  emailRecipient: string | null;
  emailSentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// A draft payout: paid/refunded orders for one place that aren't yet in a
// payout. Computed, never stored. `net = total - fees`.
export type PayoutDraft = {
  businessId: string;
  placeId: string;
  placeName: string;
  placeImage: string | null;
  orderCount: number;
  total: string; // Decimal string, EUR
  fees: string; // Decimal string, EUR
  net: string; // Decimal string, EUR
};

// Single-place preview echoing the queried range.
export type PayoutDraftPreview = PayoutDraft & {
  from: string; // ISO 8601
  to: string; // ISO 8601
};

// Result of creating a pending payout (POST /v2/treasury/payouts).
export type CreatedPayout = {
  payoutId: string;
  status: "pending";
  orderCount: number;
  total: string; // Decimal string, EUR
  fees: string; // Decimal string, EUR
  net: string; // Decimal string, EUR
  startDate: string;
  endDate: string;
};

// A single order inside a payout (review view).
export type PayoutOrder = {
  id: number;
  total: string; // Decimal string, EUR — the payer paid this
  fees: string; // Decimal string, EUR
  // What the place is owed for this order: total − fees. Computed locally —
  // the wire `due` field means "amount still owed" (often 0) and is NOT this.
  net: string; // Decimal string, EUR
  due: string; // Decimal string, EUR (wire passthrough)
  status: string; // paid | refund | refunded | correction | …
  type: string; // web | pos | terminal | …
  description: string | null;
  // Raw line-items array — shape is treasury/POS-specific, so kept opaque
  // and rendered defensively in the UI.
  items: unknown[];
  // On-chain settlement hash for this order (userOp or tx); null when CP
  // hasn't recorded one — that's the "needs minting" case.
  txHash: string | null;
  // Payer account. Null/empty ⇒ reconcile by minting to the place only;
  // non-empty ⇒ burn from this account + mint to the place.
  account: string | null;
  completedAt: string | null;
};

export type PayoutOrdersPage = {
  orders: PayoutOrder[];
  total: number;
  limit: number;
  offset: number;
  // The place's on-chain wallet — mint destination when reconciling.
  placeAccountAddress: string | null;
};

// Recomputed payout totals returned after archiving an order.
export type ArchivedPayout = {
  payoutId: string;
  total: string; // Decimal string, EUR
  fees: string; // Decimal string, EUR
  net: string; // Decimal string, EUR
};

// Input for manually adding an order to a pending payout — an amount that
// exists off-CP (e.g. a bank transfer the operator reconciles by hand).
// EUR Decimal strings (the adapter converts to cents). `description` carries
// the bank-transfer reference when the order is created from a transaction.
export type CreatePayoutOrderInput = {
  total: string; // EUR decimal — gross amount
  fees: string; // EUR decimal — platform/handling fee (may be "0")
  description: string | null;
};

// Result of manually creating an order: the new order plus the payout's
// recomputed totals, so the UI can update the header + list in place.
export type CreatedPayoutOrder = {
  order: PayoutOrder;
  payout: ArchivedPayout;
};

// =============================================================================
// Banking (Ponto connection status)
// =============================================================================

// Whether the treasury's bank connection is active and payment initiation is
// enabled. `ready` = connected && onboardingComplete && paymentInitiationEnabled
// — the gate for initiating payouts. When not connected, `status` is
// "not_connected" and the rest are false; the UI shows a "connect bank" step.
export type BankingStatus = {
  connected: boolean;
  status: string;
  accountReference: string | null;
  accountName: string | null;
  onboardingComplete: boolean;
  paymentInitiationEnabled: boolean;
  paymentInitiationRequested: boolean;
  paymentRequestsEnabled: boolean;
  ready: boolean;
};

// Bank-account balance. Native decimals (not cents) in `currency`.
export type BankBalance = {
  accountId: string;
  reference: string | null;
  currency: string;
  availableBalance: number | null;
  currentBalance: number | null;
};

// A bank-account transaction (Ponto). `amount < 0` = debit, `> 0` = credit.
export type BankTransaction = {
  id: string;
  amount: number;
  currency: string;
  executionDate: string | null;
  valueDate: string | null;
  counterpartName: string | null;
  counterpartReference: string | null;
  remittanceInformation: string | null;
  remittanceInformationType: string | null;
  description: string | null;
  createdAt: string | null;
};

// One cursor-paginated page of transactions (newest-first). `nextCursor` is
// null when there are no older pages.
export type BankTransactionsPage = {
  transactions: BankTransaction[];
  nextCursor: string | null;
};

// Result of `createPayoutPayment`. `alreadyCreated` means CP had a live
// payment for this payout already — there's no fresh signing URL to open.
export type CreatePayoutPaymentResult =
  | { alreadyCreated: true }
  | { alreadyCreated: false; paymentId: string; signingUrl: string };

export type BurnPayoutResult = {
  txHash: string;
};
