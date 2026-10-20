// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { CitizenPayBank } from "@/services/citizenpay/types";
import type { Fund } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";

import { fundCanMint } from "./readiness";

// Reads + the PENDING insert behind the public top-up page
// (app/(fund-public)/pay/[serial]). Every lookup is scoped to the fund the
// request host resolved — a card serial from another fund never matches.

// Belgian funds only for now; CP's bank directory is per country.
export const TOP_UP_BANK_COUNTRY = "BE";

export type TopUpCard = {
  id: string;
  serialNumber: string;
  account: string | null;
  status: "ACTIVE" | "INACTIVE" | "BLOCKED";
  memberId: string | null;
  member: { firstName: string; lastName: string } | null;
};

export async function loadTopUpCard(
  fundId: string,
  serial: string,
): Promise<TopUpCard | null> {
  const card = await prisma.card.findUnique({
    where: { serialNumber: serial },
    select: {
      id: true,
      fundId: true,
      serialNumber: true,
      account: true,
      status: true,
      memberId: true,
      member: { select: { firstName: true, lastName: true } },
    },
  });
  if (!card || card.fundId !== fundId) return null;
  return {
    id: card.id,
    serialNumber: card.serialNumber,
    account: card.account,
    status: card.status,
    memberId: card.memberId,
    member: card.member,
  };
}

/**
 * Can this fund take an open-banking top-up at all? PAY_AND_GO, connected to
 * a CP treasury (the payment goes to its bank account) with credentials, and
 * able to mint (token, minter wallet and CP 4337 stack provisioned).
 */
export function isTopUpReady(fund: Fund): boolean {
  return (
    fund.allocationMode === "PAY_AND_GO" &&
    !!fund.citizenPayFundId &&
    // Live CP needs the fund's API key; the dev mock doesn't.
    (!process.env.CITIZENPAY_API_BASE_URL ||
      (!!fund.citizenPayApiKeyId && !!fund.citizenPayApiKeyEnc)) &&
    fundCanMint(fund)
  );
}

/** Banks that can initiate a payment, or null when CP's directory is down. */
export async function listTopUpBanks(
  fund: Fund,
): Promise<CitizenPayBank[] | null> {
  try {
    const banks = await getCitizenPayClient(fund).listBanks({
      country: TOP_UP_BANK_COUNTRY,
    });
    return banks.filter((b) => b.paymentsEnabled);
  } catch (e) {
    console.error("[card-topup] listBanks failed", fund.id, e);
    return null;
  }
}

export function createPendingTopUp(input: {
  fundId: string;
  cardId: string;
  memberId: string | null;
  account: string;
  amountCents: number;
}): Promise<{ id: string }> {
  return prisma.cardTopUp.create({
    data: { ...input, status: "PENDING" },
    select: { id: true },
  });
}

export async function findTopUpForCard(
  fundId: string,
  serial: string,
  topUpId: string,
): Promise<{
  id: string;
  amountCents: number;
  status: "PENDING" | "SIGNED" | "MINTED" | "EXPIRED" | "CANCELLED";
  citizenPayPaymentRequestId: number | null;
} | null> {
  return prisma.cardTopUp.findFirst({
    where: { id: topUpId, fundId, card: { serialNumber: serial } },
    select: {
      id: true,
      amountCents: true,
      status: true,
      citizenPayPaymentRequestId: true,
    },
  });
}

// Per-card limits on starting a top-up (public action).
const START_MIN_INTERVAL_MS = 30 * 1000;
const MAX_OPEN_PER_CARD = 3;
const OPEN_WINDOW_MS = 60 * 60 * 1000;

/** Null when the card may start a top-up now, else the i18n error suffix. */
export async function checkStartThrottle(
  fundId: string,
  cardId: string,
  now: Date = new Date(),
): Promise<"tooSoon" | "tooMany" | null> {
  const recent = await prisma.cardTopUp.count({
    where: {
      fundId,
      cardId,
      createdAt: { gt: new Date(now.getTime() - START_MIN_INTERVAL_MS) },
    },
  });
  if (recent > 0) return "tooSoon";
  const open = await prisma.cardTopUp.count({
    where: {
      fundId,
      cardId,
      status: "PENDING",
      createdAt: { gt: new Date(now.getTime() - OPEN_WINDOW_MS) },
    },
  });
  return open >= MAX_OPEN_PER_CARD ? "tooMany" : null;
}
