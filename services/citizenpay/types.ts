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
  // Serial of the card this card pulls from when its own balance can't
  // cover a charge ("source card"). Null when no source is configured.
  sourceSerial: string | null;
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

// Result of reporting a payout burn to CP. The burn itself succeeded (a failure
// throws). The sweep of the retained cut (payoutFees + manualDeduction) is
// decoupled:
// `feeTransferTxHash` is set when it ran in the same call; `feeTransferPending`
// is true when it still needs running (via `feeTransfer`), with the reason in
// `feeTransferError`. All sweep fields are null/false when no destination was
// supplied or there was nothing to sweep.
export type PayoutBurnReport = {
  feeAmount: string | null; // EUR decimal
  feeTransferTxHash: string | null;
  feeTransferPending: boolean;
  feeTransferError: string | null;
};

// Result of the standalone fee-transfer (sweep) endpoint. A failure throws
// (CitizenPayApiError with the HTTP status); on success the hash is returned,
// with `alreadyTransferred` true when an earlier sweep had already recorded it.
export type FeeTransferResult = {
  feeAmount: string | null; // EUR decimal
  feeTransferTxHash: string;
  alreadyTransferred: boolean;
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
  // True on a burned payout whose retained cut hasn't been swept yet. Drives
  // the "fees not yet transferred" affordance; `feeTransferTxHash` is the proof.
  feeTransferPending: boolean;
  feeTransferTxHash: string | null;
};

// =============================================================================
// FEE SEMANTICS — two fee figures, two different pots of money
// =============================================================================
// Payout-shaped types below carry both, and they are NOT interchangeable:
//
//   • `fees` / `totalFees` — SOURCE-WITHHELD fees: the payment processor's
//     commission (Viva, Stripe) deducted before the money reached us. The
//     place's wallet was credited `total − fees`, so these tokens were never
//     minted and are never swept. Purely informational on our side.
//   • `payoutFees` / `totalPayoutFees` — PLATFORM fees charged at payout time
//     (the fund's own % plus the Ponto/CP method fee). These WERE minted into
//     the place's wallet and stay there until the fee sweep moves them to the
//     treasury.
//
//   net = total − fees − payoutFees − manualDeduction
//
// `net` is computed by the API; it is both the burn amount and the SEPA
// amount. The sweep moves `payoutFees + manualDeduction` — never `fees`.
// Payouts predating the split report `payoutFees` as 0.

// Normalised view of CP's `PayoutWire`. Cents-on-the-wire amounts are
// surfaced as Decimal strings (EUR) so the UI formats them like every other
// money value in the app.
// `net = totalAmount − totalFees − totalPayoutFees − manualDeduction`.
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
  totalFees: string; // Decimal string, EUR — processor fees withheld at source
  totalPayoutFees: string; // Decimal string, EUR — platform cut, swept at settlement
  manualDeduction: string; // Decimal string, EUR — admin adjustment
  manualDeductionComment: string | null;
  net: string; // Decimal string, EUR — what the merchant is paid
  status: PayoutStatus;
  // On-chain burn tx hashes once the burn step runs (CP returns one per
  // token batch). Empty until burnt.
  burnTxHashes: string[];
  // Outstanding-sweep flags (see PayoutStatusDetail). `feeTransferPending` is
  // true on a burned payout whose retained cut hasn't been swept yet.
  feeTransferPending: boolean;
  feeTransferTxHash: string | null;
  pontoPaymentId: string | null;
  pontoPaymentStatus: string | null;
  emailRecipient: string | null;
  emailSentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// A draft payout: paid/refunded orders for one place that aren't yet in a
// payout. Computed, never stored. `net = total − fees − payoutFees`.
export type PayoutDraft = {
  businessId: string;
  placeId: string;
  placeName: string;
  placeImage: string | null;
  orderCount: number;
  total: string; // Decimal string, EUR
  fees: string; // Decimal string, EUR — withheld at source
  payoutFees: string; // Decimal string, EUR — platform cut at payout
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
  fees: string; // Decimal string, EUR — withheld at source
  payoutFees: string; // Decimal string, EUR — platform cut at payout
  net: string; // Decimal string, EUR
  startDate: string;
  endDate: string;
};

// A single order inside a payout (review view).
export type PayoutOrder = {
  id: number;
  total: string; // Decimal string, EUR — the payer paid this
  fees: string; // Decimal string, EUR — processor cut withheld at source
  // This order's share of the platform cut. Unlike `fees` it WAS credited to
  // the place's wallet — the payout-level sweep takes it back at settlement.
  payoutFee: string; // Decimal string, EUR
  // What landed in the place's wallet for this order: total − fees. Computed
  // locally — the wire `due` field means "amount still owed" (often 0) and is
  // NOT this. Correct for every connector: a processor withheld its cut before
  // the credit, a bank-paid order withheld nothing (fees = 0).
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
  // Submission time — always present (unlike completedAt). Used as the anchor
  // when matching an order to its on-chain settlement transfer.
  createdAt: string | null;
};

export type PayoutOrdersPage = {
  orders: PayoutOrder[];
  total: number;
  limit: number;
  offset: number;
  // The place's on-chain wallet — mint destination when reconciling.
  placeAccountAddress: string | null;
};

// Recomputed payout totals returned after archiving an order (and by the
// other contents-changing endpoints). `net = total − fees − payoutFees`.
export type ArchivedPayout = {
  payoutId: string;
  total: string; // Decimal string, EUR
  fees: string; // Decimal string, EUR — withheld at source
  payoutFees: string; // Decimal string, EUR — platform cut at payout
  net: string; // Decimal string, EUR
};

// Input for manually adding an order to a pending payout — an amount that
// exists off-CP (e.g. a bank transfer the operator reconciles by hand).
// EUR Decimal strings (the adapter converts to cents). `description` carries
// the bank-transfer reference when the order is created from a transaction.
// The server validates `fees + payoutFee ≤ total`.
export type CreatePayoutOrderInput = {
  total: string; // EUR decimal — gross amount
  fees: string; // EUR decimal — processor cut withheld at source (may be "0")
  payoutFee: string; // EUR decimal — platform cut on this order (may be "0")
  description: string | null;
};

// Result of manually creating an order: the new order plus the payout's
// recomputed totals, so the UI can update the header + list in place.
export type CreatedPayoutOrder = {
  order: PayoutOrder;
  payout: ArchivedPayout;
};

// Aggregate over the WHOLE addable-orders window (not just the current page),
// so the UI can show a running total before the operator deselects any rows.
export type AddableOrdersSummary = {
  orderCount: number;
  total: string; // Decimal string, EUR
  fees: string; // Decimal string, EUR — withheld at source
  payoutFees: string; // Decimal string, EUR — platform cut at payout
  net: string; // Decimal string, EUR
};

// Existing orders eligible to be added to a pending payout over a required
// [from, to] window on the order's creation date. Paginated (limit/offset);
// `total` is the count across the whole window, `summary` aggregates it.
export type AddableOrdersPage = {
  orders: PayoutOrder[];
  summary: AddableOrdersSummary;
  total: number;
  limit: number;
  offset: number;
};

// One order CP refused to add (add-orders is all-or-nothing; a 422 lists every
// rejected id so the UI can drop those rows and re-preview).
export type RejectedOrder = {
  id: number;
  reason: string;
};

// Result of adding selected orders to a pending payout: how many were assigned
// plus the payout's recomputed totals (same shape as an archive recompute).
export type AddOrdersResult = {
  assigned: number;
  payout: ArchivedPayout;
};

// Input for setting a payout's manual deduction. `amount` is a EUR Decimal
// string (the adapter converts to cents); "0" clears the deduction. `comment`
// is a short free-text note explaining the adjustment. The server rejects an
// amount above `total − fees − payoutFees`.
export type SetManualDeductionInput = {
  amount: string; // EUR decimal
  comment: string | null;
};

// A pending payout's settlement window as stored after an edit. Deliberately
// carries no money: the window labels the payout, it doesn't select its orders
// (CP claims those at creation), so rewriting it can't move a total.
export type PayoutPeriod = {
  payoutId: string;
  startDate: string; // ISO 8601
  endDate: string; // ISO 8601
};

// Recomputed payout money after a manual-deduction change: the ArchivedPayout
// figures plus the deduction and its comment
// (net = total − fees − payoutFees − deduction).
export type PayoutDeduction = {
  payoutId: string;
  total: string; // EUR decimal
  fees: string; // EUR decimal — withheld at source
  payoutFees: string; // EUR decimal — platform cut at payout
  manualDeduction: string; // EUR decimal
  manualDeductionComment: string | null;
  net: string; // EUR decimal
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

// Fee configuration pushed to CP (treasury-level). `percent` is a
// decimal-percent string (e.g. "2.5" = 2.5%) — the live client converts it to
// integer basis points on the wire. `collectionFrequency` mirrors the Prisma
// `FeeCollectionFrequency` enum: PER_PAYMENT debits the fee on each merchant
// payment, MONTHLY accrues it and collects once at month end. Kept as a
// literal union here (like `CardStatus`) so the shared types module stays
// free of generated-client imports.
export type PayoutFeeConfig = {
  percent: string;
  collectionFrequency: "PER_PAYMENT" | "MONTHLY";
};
