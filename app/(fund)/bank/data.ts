// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { BankBalance, BankingStatus } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

export const TRANSACTIONS_PAGE_SIZE = 50;

function client(
  fundId: string,
  citizenPayApiKeyId: string | null,
  citizenPayApiKeyEnc: string | null,
) {
  return getCitizenPayClient({
    id: fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
  });
}

// Banking-connection status for the Bank page. Wrapped in `cache()` so the
// page + any future balance/transactions sections share one read per render.
// Degrades to a "not connected" status on error so the page can always render
// the connect step rather than a crash.
export const getBankingStatus = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
  ): Promise<BankingStatus> => {
    try {
      return await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).getBankingStatus();
    } catch (e) {
      console.warn("[bank] getBankingStatus failed", e);
      return {
        connected: false,
        status: "not_connected",
        accountReference: null,
        accountName: null,
        onboardingComplete: false,
        paymentInitiationEnabled: false,
        paymentInitiationRequested: false,
        paymentRequestsEnabled: false,
        ready: false,
      };
    }
  },
);

// Balance — null when there's no connection (the endpoint 422s) or on error;
// the page simply omits the balance card then.
export const getBankBalance = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
  ): Promise<BankBalance | null> => {
    try {
      return await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).getBankingBalance();
    } catch (e) {
      console.warn("[bank] getBankingBalance failed", e);
      return null;
    }
  },
);

// A bank transaction as mirrored in our local DB (populated by the bank-sync
// cron + the manual full-sync). This is what the Bank page shows — the
// canonical local view, including the matched member — rather than a live CP
// read. `amount` is the unsigned magnitude; `direction` carries the sign.
export type StoredBankTransaction = {
  id: string;
  direction: "INCOMING" | "OUTGOING";
  amount: string;
  currency: string;
  occurredAt: string;
  counterpartName: string | null;
  counterpartIban: string | null;
  remittanceInfo: string | null;
  memberName: string | null;
};

export type StoredBankTransactionsPage = {
  transactions: StoredBankTransaction[];
  total: number;
};

// Offset-paginated DB read, newest-first, optionally bounded to a
// `[from, to)` window on `occurredAt`. Returns the page slice + the total
// matching count so the UI can render a numbered pager. Backed by the
// `@@index([fundId, occurredAt])` on BankTransaction.
export async function fetchStoredBankTransactions(opts: {
  fundId: string;
  from: Date | null;
  to: Date | null;
  page: number;
  pageSize: number;
}): Promise<StoredBankTransactionsPage> {
  const occurredAt =
    opts.from || opts.to
      ? {
          ...(opts.from ? { gte: opts.from } : {}),
          ...(opts.to ? { lt: opts.to } : {}),
        }
      : undefined;
  const where = { fundId: opts.fundId, ...(occurredAt ? { occurredAt } : {}) };

  const [rows, total] = await Promise.all([
    prisma.bankTransaction.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: Math.max(0, (opts.page - 1) * opts.pageSize),
      take: opts.pageSize,
      select: {
        id: true,
        direction: true,
        amount: true,
        currency: true,
        occurredAt: true,
        counterpartName: true,
        counterpartIban: true,
        remittanceInfo: true,
        member: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.bankTransaction.count({ where }),
  ]);

  return {
    transactions: rows.map((b) => ({
      id: b.id,
      direction: b.direction,
      amount: b.amount.toFixed(2),
      currency: b.currency,
      occurredAt: b.occurredAt.toISOString(),
      counterpartName: b.counterpartName,
      counterpartIban: b.counterpartIban,
      remittanceInfo: b.remittanceInfo,
      memberName: b.member
        ? `${b.member.firstName} ${b.member.lastName}`.trim()
        : null,
    })),
    total,
  };
}
