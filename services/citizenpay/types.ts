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
