// SPDX-License-Identifier: AGPL-3.0-or-later
// CitizenPay client interface. Extracted to its own module so both the
// mock (`client.ts`) and the live HTTP implementation (`live-client.ts`)
// can implement it without an import cycle through the factory.

import type {
  CardOperationInput,
  CardOperationResult,
  CitizenPayCardDetail,
  CitizenPayInvite,
  CitizenPayProfile,
  ListBankTransactionsInput,
  ListBankTransactionsResult,
  ListCardsInput,
  ListCardsResult,
  ListPlacesResult,
  OperationStatusResult,
  RegisteredCard,
  RegisterCardInput,
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
   * Fetch bank movements CP has detected on the fund's account, optionally
   * since a cursor. Bank-sync uses this to mirror deposits locally, match
   * them to members, and trigger PAY_AND_GO mints. Not exposed by the v2
   * Treasury API — the live impl returns empty + logs a warning until we
   * wire a different bank feed.
   */
  listBankTransactions(
    input: ListBankTransactionsInput,
  ): Promise<ListBankTransactionsResult>;

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
}
