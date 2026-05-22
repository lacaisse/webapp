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
