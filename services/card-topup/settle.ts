// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  getCitizenPayClient,
  type FundCredentials,
} from "@/services/citizenpay/client";
import type { PaymentRequestState } from "@/services/citizenpay/types";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";
import {
  failedBeforeSubmit,
  mintToken,
  UserOpError,
  type FundMinterContext,
} from "@/services/token/userop";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";

import { centsToEuroString, centsToTokenUnits } from "./amount";
import { fundCanMint } from "./readiness";
import { outcomeFor, paymentRequestMatches, type TopUpStatus } from "./verify";

// Open-banking card top-up settlement: turn a CitizenPay treasury payment
// request into a 1:1 mint on the member's card. CitizenPay does not mint for
// top-up-only requests (its cron just marks them signed), so this is the only
// thing that credits the card.
//
// Three callers drive the same state machine:
//   - the return page's poll (app/(fund-public)/pay/[serial]/return), right
//     after the bank redirect;
//   - the bank-sync cron's sweep (sweepCardTopUps), for members who closed
//     the tab;
//   - bank-sync ingest (claimTopUpDeposit / linkTopUpDeposit), when the
//     deposit itself shows up with remittance "cp-<paymentRequestId>".
//
// PENDING → SIGNED is a guarded updateMany (where status = PENDING); the mint
// is claimed by setting tokenOperationId with a guarded updateMany (where
// status = SIGNED and tokenOperationId IS NULL) inside the transaction that
// creates the TokenOperation. Two concurrent settles serialise on the row
// lock and the loser sees count = 0, so a card is never credited twice.

export type TopUpFund = FundMinterContext &
  FundCredentials & {
    citizenPayFundId: string | null;
    tokenDecimals: number | null;
    allocationMode: "FIXED_PERIOD" | "PAY_AND_GO" | "DISABLED";
  };

export type { TopUpStatus } from "./verify";

const topUpSelect = {
  id: true,
  fundId: true,
  cardId: true,
  memberId: true,
  account: true,
  citizenPayPaymentRequestId: true,
  amountCents: true,
  status: true,
  tokenOperationId: true,
  bankTransactionId: true,
  createdAt: true,
} as const;

type TopUpRow = Prisma.CardTopUpGetPayload<{ select: typeof topUpSelect }>;

function toStatus(row: { status: TopUpRow["status"] }): TopUpStatus {
  return row.status.toLowerCase() as TopUpStatus;
}

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

async function fetchPaymentRequest(
  fund: TopUpFund,
  paymentRequestId: number,
): Promise<PaymentRequestState | null> {
  if (!fund.citizenPayFundId) throw new Error("fund not connected to CitizenPay");
  return getCitizenPayClient(fund).getPaymentRequest(
    fund.citizenPayFundId,
    paymentRequestId,
  );
}

// -----------------------------------------------------------------------------
// Payment request id (flow: the sign door creates the request in the same GET
// that redirects to the bank, so the id only comes back on the return URL)
// -----------------------------------------------------------------------------

export type AttachResult =
  | "attached" // stored now
  | "already" // this row already carries this id
  | "conflict" // the row has another id, or another top-up owns this id
  | "mismatch" // CP's request isn't this top-up (amount / account / order)
  | "unknown" // CP doesn't know the id
  | "not_found"; // no such top-up on this fund

/**
 * Record the CP payment request id the bank redirect brought back. The id
 * travels through the browser, so it is verified against CP first (top-up
 * only, same amount, same card account) and can be claimed by one top-up
 * only (unique per fund).
 */
export async function attachPaymentRequest(
  fund: TopUpFund,
  topUpId: string,
  paymentRequestId: number,
): Promise<AttachResult> {
  const row = await prisma.cardTopUp.findFirst({
    where: { id: topUpId, fundId: fund.id },
    select: topUpSelect,
  });
  if (!row) return "not_found";
  if (row.citizenPayPaymentRequestId === paymentRequestId) return "already";
  if (row.citizenPayPaymentRequestId != null) return "conflict";

  const pr = await fetchPaymentRequest(fund, paymentRequestId);
  if (!pr) return "unknown";
  if (!paymentRequestMatches(row, pr)) {
    console.warn("[card-topup] payment request does not match top-up", {
      topUpId,
      paymentRequestId,
    });
    return "mismatch";
  }

  try {
    const res = await prisma.cardTopUp.updateMany({
      where: { id: row.id, fundId: fund.id, citizenPayPaymentRequestId: null },
      data: { citizenPayPaymentRequestId: paymentRequestId },
    });
    if (res.count === 1) return "attached";
  } catch (e) {
    if (isUniqueViolation(e)) return "conflict";
    throw e;
  }
  // Lost a race with another attach of the same row.
  const again = await prisma.cardTopUp.findUnique({
    where: { id: row.id },
    select: { citizenPayPaymentRequestId: true },
  });
  return again?.citizenPayPaymentRequestId === paymentRequestId
    ? "already"
    : "conflict";
}

// -----------------------------------------------------------------------------
// Status → mint
// -----------------------------------------------------------------------------

/**
 * Advance one top-up as far as CP's status allows: PENDING → SIGNED / EXPIRED
 * / CANCELLED, and SIGNED → MINTED. Safe to call any number of times, from
 * any number of places at once. Returns the resulting status.
 */
export async function settleCardTopUp(
  fund: TopUpFund,
  topUpId: string,
): Promise<TopUpStatus> {
  let row = await prisma.cardTopUp.findFirst({
    where: { id: topUpId, fundId: fund.id },
    select: topUpSelect,
  });
  if (!row) throw new Error(`card top-up ${topUpId} not found`);

  if (row.status === "PENDING") {
    // No id yet: the member hasn't come back from the bank (and bank-sync
    // hasn't recovered it from the deposit). Nothing to ask CP.
    if (row.citizenPayPaymentRequestId == null) return "pending";

    const pr = await fetchPaymentRequest(fund, row.citizenPayPaymentRequestId);
    const outcome = outcomeFor(pr);
    if (outcome === "pending") return "pending";
    if (outcome === "signed") {
      // Re-verified at mint time too: never mint on a request that isn't
      // exactly this top-up, whatever path stored its id.
      if (!pr || !paymentRequestMatches(row, pr)) {
        console.error("[card-topup] signed request does not match top-up", {
          topUpId,
          paymentRequestId: row.citizenPayPaymentRequestId,
        });
        return "pending";
      }
      await prisma.cardTopUp.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { status: "SIGNED" },
      });
    } else {
      await prisma.cardTopUp.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { status: outcome === "expired" ? "EXPIRED" : "CANCELLED" },
      });
    }
    row = await prisma.cardTopUp.findUniqueOrThrow({
      where: { id: row.id },
      select: topUpSelect,
    });
  }

  if (row.status === "SIGNED" && row.tokenOperationId == null) {
    await mintCardTopUp(fund, row);
    row = await prisma.cardTopUp.findUniqueOrThrow({
      where: { id: row.id },
      select: topUpSelect,
    });
  }

  return toStatus(row);
}

class ClaimLost extends Error {}

// UserOpError codes raised while building the userop, before anything is
// handed to the bundler.
const PRE_SUBMIT_CODES: ReadonlySet<string> = new Set([
  "config",
  "fund_not_provisioned",
  "no_token",
  "unsupported_chain",
]);

export type MintResult = "minted" | "already_claimed" | "failed";

/**
 * Mint a SIGNED top-up's amount to its card, exactly once. The claim (a
 * TokenOperation + tokenOperationId on the row) commits before the userop is
 * sent, so a second caller backs off. On a failure that certainly happened
 * before the userop was sent, the claim is released for the next poll /
 * sweep to retry; any other failure keeps it (the mint may be on chain) and
 * leaves the top-up SIGNED with a FAILED op for an operator.
 */
export async function mintCardTopUp(
  fund: TopUpFund,
  row: Pick<TopUpRow, "id" | "account" | "amountCents" | "memberId">,
): Promise<MintResult> {
  if (!fundCanMint(fund) || fund.tokenDecimals == null) {
    // Nothing claimed: the top-up stays SIGNED and the sweep retries once
    // the fund's token / minter is provisioned.
    console.error("[card-topup] fund cannot mint", fund.id);
    return "failed";
  }
  const units = centsToTokenUnits(row.amountCents, fund.tokenDecimals);

  let opId: string;
  try {
    opId = await prisma.$transaction(async (tx) => {
      const op = await tx.tokenOperation.create({
        data: {
          fundId: fund.id,
          type: "MINT",
          memberId: row.memberId,
          account: row.account,
          amount: centsToEuroString(row.amountCents),
          status: "PENDING",
        },
        select: { id: true },
      });
      const claimed = await tx.cardTopUp.updateMany({
        where: { id: row.id, status: "SIGNED", tokenOperationId: null },
        data: { tokenOperationId: op.id },
      });
      if (claimed.count !== 1) throw new ClaimLost();
      // Read after our write: a deposit linked concurrently is visible here
      // (or its linker sees our tokenOperationId — either way one of us
      // records the source link).
      const linked = await tx.cardTopUp.findUnique({
        where: { id: row.id },
        select: { bankTransactionId: true },
      });
      if (linked?.bankTransactionId) {
        await tx.tokenOperationSource.create({
          data: {
            bankTransactionId: linked.bankTransactionId,
            tokenOperationId: op.id,
          },
        });
      }
      return op.id;
    });
  } catch (e) {
    if (e instanceof ClaimLost) return "already_claimed";
    throw e;
  }

  try {
    const { txHash, userOpHash } = await mintToken({
      fund,
      to: row.account as `0x${string}`,
      amount: units,
    });
    await prisma.tokenOperation.update({
      where: { id: opId },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    await prisma.cardTopUp.updateMany({
      where: { id: row.id, tokenOperationId: opId },
      data: { status: "MINTED" },
    });
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: ANNOTATION_TRIGGERS.cardTopUp,
      trigger: ANNOTATION_TRIGGERS.cardTopUp,
      triggeredByUserId: null,
    });
    return "minted";
  } catch (e) {
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    await prisma.tokenOperation.update({
      where: { id: opId },
      data: { status: "FAILED", errorMessage },
    });
    if (failedBeforeSubmit(e) || (e instanceof UserOpError && PRE_SUBMIT_CODES.has(e.code))) {
      // Nothing was sent: hand the top-up back for a retry.
      await prisma.cardTopUp.updateMany({
        where: { id: row.id, tokenOperationId: opId },
        data: { tokenOperationId: null },
      });
    }
    console.error("[card-topup] mint failed", row.id, opId, e);
    return "failed";
  }
}

// -----------------------------------------------------------------------------
// Cron safety net
// -----------------------------------------------------------------------------

// Leave fresh top-ups to the return page's poll.
const SWEEP_MIN_AGE_MS = 60 * 1000;
// CP gives up on an unsigned request after 15 minutes; past this, a top-up the
// member never came back from (no request id) is expired. A late deposit
// still revives it through bank-sync (claimTopUpDeposit).
const ORPHAN_EXPIRY_MS = 60 * 60 * 1000;
// Don't keep asking CP about the same requests forever.
const SWEEP_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
// How far back bank-sync looks for an orphan top-up to adopt a deposit.
const ORPHAN_ADOPT_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

export type SweepStats = { checked: number; minted: number; closed: number; errors: number };

/**
 * Finish top-ups whose member closed the tab: re-check PENDING / SIGNED ones
 * older than a minute (signed → mint; expired / cancelled → mark), and expire
 * PENDING ones that never got a request id.
 */
export async function sweepCardTopUps(
  fund: TopUpFund,
  now: Date = new Date(),
): Promise<SweepStats> {
  const stats: SweepStats = { checked: 0, minted: 0, closed: 0, errors: 0 };

  const orphans = await prisma.cardTopUp.updateMany({
    where: {
      fundId: fund.id,
      status: "PENDING",
      citizenPayPaymentRequestId: null,
      createdAt: { lt: new Date(now.getTime() - ORPHAN_EXPIRY_MS) },
    },
    data: { status: "EXPIRED" },
  });
  stats.closed += orphans.count;

  const due = await prisma.cardTopUp.findMany({
    where: {
      fundId: fund.id,
      status: { in: ["PENDING", "SIGNED"] },
      tokenOperationId: null,
      citizenPayPaymentRequestId: { not: null },
      createdAt: { lt: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
      updatedAt: { gt: new Date(now.getTime() - SWEEP_MAX_AGE_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });

  for (const { id } of due) {
    stats.checked++;
    try {
      const status = await settleCardTopUp(fund, id);
      if (status === "minted") stats.minted++;
      else if (status === "expired" || status === "cancelled") stats.closed++;
    } catch (e) {
      stats.errors++;
      console.error("[card-topup] sweep failed", id, e);
    }
  }
  return stats;
}

// -----------------------------------------------------------------------------
// Bank-sync
// -----------------------------------------------------------------------------

/** "12.50" (bank decimal string) → 1250; null when not a whole cent amount. */
export function depositCents(amount: string): number | null {
  const cents = new Prisma.Decimal(amount).abs().mul(100);
  return cents.isInteger() ? cents.toNumber() : null;
}

export type TopUpDeposit = {
  topUpId: string;
  cardId: string;
  memberId: string | null;
};

/**
 * Is this incoming deposit an open-banking top-up of this fund? Looks up the
 * CardTopUp by the "cp-<id>" remittance; when none carries the id yet (the
 * member never came back from the bank), asks CP what the request was and
 * adopts the matching orphan top-up — or, for a PAY_AND_GO fund, records the
 * top-up from the deposit itself (the money is in the fund's account and CP's
 * request names the card). `live` = the cron (may ask CP and create rows);
 * a backfill only looks up existing rows.
 */
export async function claimTopUpDeposit(
  fund: TopUpFund,
  args: { paymentRequestId: number; amount: string; live: boolean },
): Promise<TopUpDeposit | null> {
  const cents = depositCents(args.amount);
  if (cents == null) return null;

  const known = await prisma.cardTopUp.findUnique({
    where: {
      fundId_citizenPayPaymentRequestId: {
        fundId: fund.id,
        citizenPayPaymentRequestId: args.paymentRequestId,
      },
    },
    select: { id: true, cardId: true, memberId: true, amountCents: true },
  });
  if (known) {
    if (known.amountCents !== cents) {
      console.warn("[card-topup] deposit amount differs from top-up", {
        topUpId: known.id,
        cents,
      });
      return null;
    }
    return { topUpId: known.id, cardId: known.cardId, memberId: known.memberId };
  }
  if (!args.live) return null;

  const pr = await fetchPaymentRequest(fund, args.paymentRequestId);
  if (!pr || pr.orderId != null || !pr.account || pr.amountCents !== cents) {
    return null;
  }
  const card = await prisma.card.findFirst({
    where: { fundId: fund.id, account: { equals: pr.account, mode: "insensitive" } },
    select: { id: true, account: true, memberId: true },
  });
  if (!card?.account) return null;

  // An orphan the member started but never came back from: same card, same
  // amount, no id yet, oldest first.
  const orphan = await prisma.cardTopUp.findFirst({
    where: {
      fundId: fund.id,
      cardId: card.id,
      amountCents: cents,
      citizenPayPaymentRequestId: null,
      status: { in: ["PENDING", "EXPIRED"] },
      // Bank feeds can lag a few days behind the payment.
      createdAt: { gt: new Date(Date.now() - ORPHAN_ADOPT_WINDOW_MS) },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, memberId: true },
  });
  try {
    if (orphan) {
      const res = await prisma.cardTopUp.updateMany({
        where: { id: orphan.id, citizenPayPaymentRequestId: null },
        data: { citizenPayPaymentRequestId: args.paymentRequestId },
      });
      if (res.count === 1) {
        return { topUpId: orphan.id, cardId: card.id, memberId: orphan.memberId };
      }
    } else if (fund.allocationMode === "PAY_AND_GO") {
      const created = await prisma.cardTopUp.create({
        data: {
          fundId: fund.id,
          cardId: card.id,
          memberId: card.memberId,
          account: card.account,
          citizenPayPaymentRequestId: args.paymentRequestId,
          amountCents: cents,
          status: "PENDING",
        },
        select: { id: true },
      });
      return { topUpId: created.id, cardId: card.id, memberId: card.memberId };
    } else {
      return null;
    }
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  // Raced another claim of the same id: use whichever row owns it now.
  const owner = await prisma.cardTopUp.findUnique({
    where: {
      fundId_citizenPayPaymentRequestId: {
        fundId: fund.id,
        citizenPayPaymentRequestId: args.paymentRequestId,
      },
    },
    select: { id: true, cardId: true, memberId: true },
  });
  return owner
    ? { topUpId: owner.id, cardId: owner.cardId, memberId: owner.memberId }
    : null;
}

/**
 * Tie the deposit to its top-up. The deposit is proof of payment: on the live
 * cron a top-up not yet minted (still PENDING, or closed EXPIRED / CANCELLED
 * by a CP that lost track of it) moves to SIGNED and is minted here. An
 * already-minted top-up gets the deposit as its mint's source, which also
 * locks the row against re-attribution. Returns whether this call minted.
 */
export async function linkTopUpDeposit(
  fund: TopUpFund,
  topUpId: string,
  bankTransactionId: string,
  live: boolean,
): Promise<boolean> {
  await prisma.cardTopUp.updateMany({
    where: { id: topUpId, bankTransactionId: null },
    data: { bankTransactionId },
  });
  const row = await prisma.cardTopUp.findUniqueOrThrow({
    where: { id: topUpId },
    select: topUpSelect,
  });

  if (row.tokenOperationId) {
    await prisma.tokenOperationSource.upsert({
      where: {
        bankTransactionId_tokenOperationId: {
          bankTransactionId,
          tokenOperationId: row.tokenOperationId,
        },
      },
      create: { bankTransactionId, tokenOperationId: row.tokenOperationId },
      update: {},
    });
    return false;
  }
  if (!live) return false;

  await prisma.cardTopUp.updateMany({
    where: { id: row.id, status: { in: ["PENDING", "EXPIRED", "CANCELLED"] } },
    data: { status: "SIGNED" },
  });
  return (await mintCardTopUp(fund, row)) === "minted";
}
