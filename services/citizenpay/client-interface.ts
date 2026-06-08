// SPDX-License-Identifier: AGPL-3.0-or-later
// CitizenPay client interface. Extracted to its own module so both the
// mock (`client.ts`) and the live HTTP implementation (`live-client.ts`)
// can implement it without an import cycle through the factory.

import type {
  ArchivedPayout,
  BankBalance,
  BankingStatus,
  BankTransactionPayloadPage,
  BankTransactionsPage,
  CardOperationInput,
  CardOperationResult,
  CitizenPayCardDetail,
  CitizenPayInvite,
  CitizenPayProfile,
  CreatedPayout,
  CreatedPayoutOrder,
  CreatePayoutOrderInput,
  CreatePayoutPaymentResult,
  FeeTransferResult,
  ListBankTransactionsInput,
  ListBankTransactionsResult,
  ListCardsInput,
  ListCardsResult,
  ListPlacesResult,
  OperationStatusResult,
  Payout,
  PayoutBurnReport,
  PayoutDeduction,
  PayoutDraft,
  PayoutDraftPreview,
  PayoutOrdersPage,
  PayoutStatusDetail,
  RegisteredCard,
  RegisterCardInput,
  SetManualDeductionInput,
  SubmitMintInput,
  SubmittedOperation,
} from "./types";

export interface CitizenPayClient {
  /**
   * Register a physical card with CitizenPay. The fund hands a card with a
   * known NFC serial to a member; we call this to create the corresponding
   * on-chain wallet on CP's side. Returns the wallet `account` we then
   * store on the local Card row.
   */
  registerCard(input: RegisterCardInput): Promise<RegisteredCard>;

  /**
   * Tell CP to stop accepting charges from this card (member reported lost,
   * suspicious activity, etc.). Idempotent — calling it on an already-
   * blocked card is a no-op.
   */
  blockCard(serialNumber: string): Promise<void>;

  /** Reverse of `blockCard`. Idempotent. */
  unblockCard(serialNumber: string): Promise<void>;

  /**
   * Submit a mint to CP. Returns a tx hash we can poll later for
   * confirmation. On v2 the underlying top-up is synchronous, but we keep
   * the PENDING/poll shape so the cron + mock + future-async semantics all
   * line up.
   */
  submitMint(input: SubmitMintInput): Promise<SubmittedOperation>;

  /**
   * Poll CP for the current state of a previously-submitted operation.
   * The polling cron uses this to flip PENDING rows to CONFIRMED / FAILED.
   */
  getOperationStatus(txHash: string): Promise<OperationStatusResult>;

  /**
   * Fetch bank movements CP has detected on the fund's account, since the
   * fund's last-sync watermark. Bank-sync uses this to mirror deposits
   * locally, match them to members, and trigger PAY_AND_GO mints. Backed by
   * the same banking feed as `getBankTransactionPayloadPage` — it pages until
   * it crosses the watermark.
   */
  listBankTransactions(
    input: ListBankTransactionsInput,
  ): Promise<ListBankTransactionsResult>;

  /**
   * One cursor-paginated page of ingest-shaped bank transactions
   * (newest-first), for the manual full-sync. Pass the returned `nextCursor`
   * back to load the next (older) page; a `null` cursor means history is
   * exhausted. Same feed as `listBankTransactions`, but caller-paged so the
   * UI can show progress without one long-running request.
   */
  getBankTransactionPayloadPage(query?: {
    limit?: number;
    cursor?: string;
  }): Promise<BankTransactionPayloadPage>;

  /**
   * List all merchant places connected to this treasury, with their on-chain
   * wallet address when available. Used by the token explorer to enumerate
   * non-card holders (places receive token payments from cards) and by the
   * merchant sync to discover newly-connected places.
   */
  listPlaces(): Promise<ListPlacesResult>;

  /**
   * Disconnect a business from this treasury — CP removes the token from
   * every place under that business. Idempotent: a missing business
   * (already disconnected) is treated as success. The caller is
   * responsible for clearing the local `citizenPayPlaceId` / `businessId`
   * fields on all sibling Merchant rows after this returns.
   */
  disconnectBusiness(businessId: string): Promise<void>;

  /**
   * Mint + send an email invite to a merchant. CP sends the branded
   * email; we just need to persist the returned token so the callback
   * can look it up. Calling again for the same email auto-rejects the
   * previous pending invite on CP's side.
   */
  createMerchantInvite(args: {
    email: string;
    redirectUri?: string;
  }): Promise<CitizenPayInvite>;

  /**
   * Server-side verification of an invite token. Used by the callback
   * route to confirm the status CP put on the redirect query string —
   * those query params are a hint, not proof.
   */
  getMerchantInvite(token: string): Promise<CitizenPayInvite | null>;

  /**
   * Fetch a CitizenPay-hosted profile (display name, avatar) for an
   * on-chain account. Returns null when CP has no profile for the address.
   * Used by the token explorer to label external wallets that aren't a
   * local card/place/minter.
   */
  getProfile(account: string): Promise<CitizenPayProfile | null>;

  /**
   * Batch-fetch CitizenPay-hosted profiles. The returned array is
   * positionally aligned with `accounts` — same length, `null` for misses.
   * Used by the 3-tier address resolver to fill the persisted cache in one
   * round-trip per page render. Caller is responsible for chunking >200
   * accounts (CP's per-request cap).
   */
  getProfiles(accounts: string[]): Promise<Array<CitizenPayProfile | null>>;

  /**
   * Top up a card by serial — mints tokens to the card's CP-managed
   * wallet and returns the on-chain tx hash. The v2 endpoint is
   * synchronous; the returned hash is already confirmed.
   */
  topUpCard(input: CardOperationInput): Promise<CardOperationResult>;

  /**
   * Withdraw from a card by serial — burns tokens from the card's
   * CP-managed wallet and returns the on-chain tx hash. Synchronous on v2.
   */
  withdrawFromCard(input: CardOperationInput): Promise<CardOperationResult>;

  /**
   * List the cards CitizenPay knows about for this treasury. Used by
   * the cards reconciliation view to surface drift against local Card rows.
   * Iterates pagination internally — the call site receives a full list.
   */
  listCitizenPayCards(input?: ListCardsInput): Promise<ListCardsResult>;

  /**
   * Update a card's status on CitizenPay. Used by the sync page to push
   * the locally-authoritative status to CP when the two diverged.
   */
  setCardStatus(
    serialNumber: string,
    status: "ACTIVE" | "INACTIVE" | "BLOCKED",
  ): Promise<void>;

  /**
   * Delete a card on CitizenPay by serial — used to clean up CP orphans
   * (cards present on CP but missing from our local DB). The local Card
   * delete flow also calls this to keep the two sides in lockstep.
   * Idempotent: missing cards are treated as already-deleted.
   */
  deleteCard(serialNumber: string): Promise<void>;

  /**
   * Read-only fetch of a single CP card with its on-chain account.
   * Used by the import flow on /cards/sync to pull CP-only cards into
   * the local DB. Returns null when the card doesn't exist on CP.
   */
  getCitizenPayCard(
    serialNumber: string,
  ): Promise<CitizenPayCardDetail | null>;

  /**
   * Draft payouts: paid/refunded orders not yet attached to a payout,
   * grouped by place. Computed live — calling it never mutates anything.
   * Optional half-open `[from, to)` window narrows the orders considered;
   * omitted means all unassigned orders. Only places with positive net
   * are returned. Drives the Payments → Payouts "Drafts" view.
   */
  listPayoutDrafts(query?: {
    from?: string;
    to?: string;
  }): Promise<PayoutDraft[]>;

  /**
   * Live count/total for one place over a required `[from, to)` range —
   * what the create-payout dialog shows before the admin commits. Same
   * shape as a draft row plus the echoed range.
   */
  previewPayoutDraft(args: {
    placeId: string;
    from: string;
    to: string;
  }): Promise<PayoutDraftPreview>;

  /**
   * Materialise a pending payout from a place + range — atomically claims
   * the matching orders (they drop out of drafts). Throws on no payable
   * orders / bad range (the API returns 400) or a place that isn't ours
   * (403).
   */
  createPayout(args: {
    placeId: string;
    from: string;
    to: string;
  }): Promise<CreatedPayout>;

  /**
   * The exact orders inside a payout, paginated (limit max 50). Drives the
   * order-review + reconciliation step. Each order carries its settlement
   * `txHash` + payer `account`; the page envelope carries the place's
   * `placeAccountAddress` (the mint destination).
   */
  getPayoutOrders(
    payoutId: string,
    query?: { limit?: number; offset?: number },
  ): Promise<PayoutOrdersPage>;

  /**
   * Record a new settlement hash on an order after the dashboard has minted
   * (the no-tx-hash / unsettled case). The server re-runs its confirmation
   * lifecycle against the hash. Only valid while the payout is pending.
   */
  recordOrderTxHash(
    payoutId: string,
    orderId: number,
    txHash: string,
  ): Promise<void>;

  /**
   * Manually add an order to a pending payout — for an amount that exists
   * off-CP (a bank transfer reconciled by hand, a manual adjustment, …).
   * EUR decimal amounts; `description` carries the bank-transfer reference
   * when created from a transaction. Returns the created order + the payout's
   * recomputed totals. Only valid while the payout is pending (CP returns 409
   * otherwise). Backed by `POST /v2/treasury/payouts/{id}/orders`.
   */
  createPayoutOrder(
    payoutId: string,
    input: CreatePayoutOrderInput,
  ): Promise<CreatedPayoutOrder>;

  /**
   * Archive an order out of a pending payout (unlink + recompute totals).
   * Returns the payout's recomputed totals so the UI can update in place.
   */
  archiveOrder(payoutId: string, orderId: number): Promise<ArchivedPayout>;

  /**
   * Set a payout's manual deduction (+ comment), recomputing `net`
   * (total − fees − deduction). EUR decimal `amount`; "0" clears it. Only
   * valid while the payout isn't complete (CP rejects otherwise). Returns the
   * recomputed totals so the UI can update the header in place. Backed by
   * POST /v2/treasury/payouts/{id}/manual-deduction.
   */
  setManualDeduction(
    payoutId: string,
    input: SetManualDeductionInput,
  ): Promise<PayoutDeduction>;

  /**
   * Clear a payout's manual deduction + comment (resets to 0 / null), with
   * `net` back to total − fees. Same `pending`-only gate as setManualDeduction.
   * Returns the recomputed totals. Backed by DELETE
   * /v2/treasury/payouts/{id}/manual-deduction.
   */
  clearManualDeduction(payoutId: string): Promise<PayoutDeduction>;

  /**
   * The treasury's bank-connection status (Ponto). Read-only — activation
   * runs through the merchant dashboard's OAuth flow, not a treasury API key.
   * Degrades to a "not connected" status rather than throwing.
   */
  getBankingStatus(): Promise<BankingStatus>;

  /**
   * The connected bank account's balance (native decimals, not cents).
   * Throws (422) when there's no connection — callers degrade.
   */
  getBankingBalance(): Promise<BankBalance>;

  /**
   * One cursor-paginated page of bank-account transactions, newest-first.
   * Pass the returned `nextCursor` back to load older pages. Throws (422)
   * when there's no connection.
   */
  getBankingTransactions(query?: {
    limit?: number;
    cursor?: string;
  }): Promise<BankTransactionsPage>;

  /**
   * Merchant payouts awaiting settlement — CP has aggregated the tokens a
   * place collected over a period but the treasury hasn't paid the fiat
   * leg yet. Drives the pending side of the Payments → Payouts view.
   */
  listPendingPayouts(): Promise<Payout[]>;

  /**
   * Payouts whose settlement has run (burnt / complete). Drives the
   * completed side of the Payments → Payouts view.
   */
  listCompletedPayouts(): Promise<Payout[]>;

  /**
   * Full detail for one payout — total / fees / manual deduction (+ comment) /
   * net. Backed by GET /v2/treasury/payouts/{id}. Carries the stored status
   * only (use getPayoutStatus for the live lifecycle). Throws (404) when the
   * id isn't found — callers degrade.
   */
  getPayout(payoutId: string): Promise<Payout>;

  /**
   * Live status of a single payout, plus the Ponto `signingUrl` while it's
   * `payment-pending`. The signing link is only returned when `redirectUrl`
   * is supplied (an https URL Ponto sends the operator to after signing).
   */
  getPayoutStatus(
    payoutId: string,
    opts?: { redirectUrl?: string },
  ): Promise<PayoutStatusDetail>;

  /**
   * Step 1 of settlement: ask CP to create the SEPA payment for this payout.
   * Returns a `signingUrl` the admin opens at their bank to authorise the
   * transfer, or `{ alreadyCreated: true }` when CP already has a live
   * payment (nothing new to sign).
   */
  createPayoutPayment(
    payoutId: string,
    args?: { redirectUrl?: string },
  ): Promise<CreatePayoutPaymentResult>;

  /**
   * Report the on-chain burn for this payout to CP. The dashboard burns the
   * place's tokens (the payout `net`) with its own minter wallet, then hands
   * CP the resulting tx hash; CP marks the payout `burnt`. CP no longer burns
   * server-side. When `destination` is supplied, CP also sweeps the retained
   * cut (fees + manualDeduction) from the place account to it and returns the
   * transfer hash + amount. Irreversible — confirm with the admin before the
   * burn.
   */
  burnPayout(
    payoutId: string,
    txHash: string,
    destination?: string,
  ): Promise<PayoutBurnReport>;

  /**
   * Run (or retry) just the fee sweep to `destination` — the standalone,
   * idempotent counterpart to the burn's inline sweep. Use it when a burn's
   * sweep came back pending. Throws CitizenPayApiError on sweep failure (402
   * insufficient, 409 not-burnt/in-progress, 422 config, 503 bundler, 400 bad
   * destination). Backed by POST /v2/treasury/payouts/{id}/fee-transfer.
   */
  feeTransfer(payoutId: string, destination: string): Promise<FeeTransferResult>;

  /**
   * Admin override: mark a payout `complete` without burning tokens or
   * initiating a SEPA payment — for when the treasury settled with the
   * merchant some other way. Pure status flip, allowed from any non-complete
   * status. Backed by `POST /v2/treasury/payouts/{id}/complete`. Confirm with
   * the admin first — it bypasses settlement and can't be undone.
   */
  completePayout(payoutId: string): Promise<void>;

  /**
   * Push the platform fee percentage to CitizenPay (treasury-level). `percent`
   * is a decimal-percent string (e.g. "2.5" = 2.5%); the live client converts
   * it to integer basis points on the wire. We are canonical for this value —
   * it's persisted locally first, then synced here. ⚠️ ASSUMED CP endpoint
   * (PATCH /v2/treasury) until CP ships it.
   */
  setPayoutFeePercentage(percent: string): Promise<void>;
}
