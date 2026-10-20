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
  attemptedUserOpHash,
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
//     the tab, and to finish / flag anything left half-done;
//   - bank-sync ingest (claimTopUpDeposit / linkTopUpDeposit), when the
//     deposit itself shows up with remittance "cp-<paymentRequestId>".
//
// PENDING → SIGNED is a guarded updateMany (where status = PENDING); the mint
// is claimed by setting tokenOperationId with a guarded updateMany (where
// status = SIGNED and tokenOperationId IS NULL) inside the transaction that
// creates the TokenOperation. Two concurrent settles serialise on the row
// lock and the loser sees count = 0, so a card is never credited twice.
//
// The claimed TokenOperation is owned by this module: the generic mint-retry
// cron (services/token-operations/retry.ts) skips ops linked to a CardTopUp,
// so a mint still in flight (or killed mid-flight) is never re-submitted.
// Once mintToken has resolved the userop is on its way: nothing after that
// may mark the op FAILED or release the claim — bookkeeping failures are
// logged and the sweep finishes them from the recorded hashes.

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
  mintTxHash: true,
  mintUserOpHash: true,
  mintAttempts: true,
  nextMintAttemptAt: true,
  createdAt: true,
  updatedAt: true,
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

// Logged, never thrown: used for bookkeeping after the userop was submitted.
async function bestEffort(label: string, ids: object, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[card-topup] ${label} failed (left for the sweep)`, ids, e);
  }
}

// -----------------------------------------------------------------------------
// Payment request id (flow: the sign door creates the request in the same GET
// that redirects to the bank, so the id only comes back on the return URL)
// -----------------------------------------------------------------------------

export type AttachResult =
  | "attached" // stored now
  | "already" // this row already carries this id
  | "conflict" // the row has another id, or another top-up owns this id
  | "mismatch" // CP's request isn't this top-up (treasury / amount / account / order)
  | "unknown" // CP doesn't know the id
  | "not_found"; // no such top-up on this fund

/**
 * Record the CP payment request id the bank redirect brought back. The id
 * travels through the browser, so it is verified against CP first (this
 * fund's treasury, top-up only, same amount, same card account) and can be
 * claimed by one top-up only (unique per fund).
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
  if (!paymentRequestMatches(row, pr, fund.citizenPayFundId)) {
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
  now: Date = new Date(),
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
      if (!pr || !paymentRequestMatches(row, pr, fund.citizenPayFundId)) {
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

  if (row.status === "SIGNED") {
    if (row.tokenOperationId == null) await mintCardTopUp(fund, row, now);
    else await completeClaimedMint(fund, row);
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

// A released claim waits before the next attempt (1 min, doubling, capped at
// 6 h), and a top-up stops retrying after this many — the sweep flags it.
export const MAX_MINT_ATTEMPTS = 6;
const MINT_BACKOFF_BASE_MS = 60 * 1000;
const MINT_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function mintBackoffMs(attempts: number): number {
  return Math.min(
    MINT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    MINT_BACKOFF_MAX_MS,
  );
}

export type MintResult =
  | "minted"
  | "already_claimed"
  | "not_ready" // fund can't mint, backoff pending, or attempts exhausted
  | "failed";

/**
 * Mint a SIGNED top-up's amount to its card, exactly once. The claim (a
 * TokenOperation + tokenOperationId on the row) commits before the userop is
 * sent, so a second caller backs off. On a failure that certainly happened
 * before the userop was sent, the claim is released with a backoff for the
 * next poll / sweep to retry; any other failure keeps it (the mint may be on
 * chain) and leaves the top-up SIGNED with a FAILED op for an operator.
 */
export async function mintCardTopUp(
  fund: TopUpFund,
  row: TopUpRow,
  now: Date = new Date(),
): Promise<MintResult> {
  if (!fundCanMint(fund) || fund.tokenDecimals == null) {
    // Nothing claimed: the top-up stays SIGNED and the sweep retries once
    // the fund's token / minter is provisioned.
    console.error("[card-topup] fund cannot mint", fund.id);
    return "not_ready";
  }
  if (row.mintAttempts >= MAX_MINT_ATTEMPTS) return "not_ready";
  if (row.nextMintAttemptAt && row.nextMintAttemptAt > now) return "not_ready";
  const units = centsToTokenUnits(row.amountCents, fund.tokenDecimals);
  const attempts = row.mintAttempts + 1;

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
        where: {
          id: row.id,
          status: "SIGNED",
          tokenOperationId: null,
          OR: [{ nextMintAttemptAt: null }, { nextMintAttemptAt: { lte: now } }],
        },
        data: { tokenOperationId: op.id, mintAttempts: attempts },
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

  let minted: { txHash: string; userOpHash: string };
  try {
    minted = await mintToken({
      fund,
      to: row.account as `0x${string}`,
      amount: units,
    });
  } catch (e) {
    await recordMintFailure(row, opId, attempts, e, now);
    return "failed";
  }

  // Submitted. From here on, only bookkeeping — logged, never thrown, never
  // FAILED: the sweep (completeClaimedMint) finishes whatever didn't stick.
  const ids = { topUpId: row.id, opId };
  await bestEffort("record mint", ids, () =>
    prisma.cardTopUp.updateMany({
      where: { id: row.id, tokenOperationId: opId },
      data: {
        status: "MINTED",
        mintTxHash: minted.txHash,
        mintUserOpHash: minted.userOpHash,
        nextMintAttemptAt: null,
      },
    }),
  );
  await bestEffort("confirm op", ids, () =>
    prisma.tokenOperation.update({
      where: { id: opId },
      data: { status: "CONFIRMED", txHash: minted.txHash, confirmedAt: new Date() },
    }),
  );
  await bestEffort("annotate", ids, () =>
    resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash: minted.userOpHash,
      kind: ANNOTATION_TRIGGERS.cardTopUp,
      trigger: ANNOTATION_TRIGGERS.cardTopUp,
      triggeredByUserId: null,
    }),
  );
  return "minted";
}

async function recordMintFailure(
  row: TopUpRow,
  opId: string,
  attempts: number,
  e: unknown,
  now: Date,
): Promise<void> {
  const userOpHash = attemptedUserOpHash(e);
  const preSubmit =
    failedBeforeSubmit(e) ||
    (e instanceof UserOpError && PRE_SUBMIT_CODES.has(e.code));
  const errorMessage =
    (e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e)) +
    (userOpHash ? ` [userOp ${userOpHash}]` : "");
  console.error("[card-topup] mint failed", {
    topUpId: row.id,
    opId,
    preSubmit,
    userOpHash,
    error: errorMessage,
  });

  try {
    await prisma.tokenOperation.update({
      where: { id: opId },
      data: { status: "FAILED", errorMessage },
    });
  } catch (err) {
    // The op stays PENDING and linked to the top-up — the mint-retry cron
    // skips it, the claim stays: an operator decides.
    console.error("[card-topup] could not mark op failed", opId, err);
    return;
  }

  if (preSubmit) {
    // Nothing was sent: hand the top-up back, after a backoff.
    await bestEffort("release claim", { topUpId: row.id, opId }, () =>
      prisma.cardTopUp.updateMany({
        where: { id: row.id, tokenOperationId: opId },
        data: {
          tokenOperationId: null,
          nextMintAttemptAt: new Date(now.getTime() + mintBackoffMs(attempts)),
        },
      }),
    );
  } else if (userOpHash) {
    // May be on chain: keep the claim and keep the handle to check it.
    await bestEffort("record userop", { topUpId: row.id, opId }, () =>
      prisma.cardTopUp.updateMany({
        where: { id: row.id, tokenOperationId: opId },
        data: { mintUserOpHash: userOpHash },
      }),
    );
  }
}

/**
 * Finish a claimed mint whose userop went out but whose bookkeeping didn't
 * all land: the settlement tx hash is on the row (mintTxHash) or the op
 * (txHash). Without either, nothing is known — leave it for an operator.
 * Returns true when the row is (now) MINTED.
 */
export async function completeClaimedMint(
  fund: TopUpFund,
  row: TopUpRow,
): Promise<boolean> {
  if (!row.tokenOperationId) return false;
  const op = await prisma.tokenOperation.findUnique({
    where: { id: row.tokenOperationId },
    select: { id: true, status: true, txHash: true },
  });
  if (!op) return false;
  const txHash = row.mintTxHash ?? op.txHash;
  if (!txHash || op.status === "FAILED") return row.status === "MINTED";

  if (op.status === "PENDING") {
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
  }
  if (row.status !== "MINTED") {
    await prisma.cardTopUp.updateMany({
      where: { id: row.id, tokenOperationId: op.id, status: "SIGNED" },
      data: { status: "MINTED", mintTxHash: txHash },
    });
    if (row.mintUserOpHash) {
      await bestEffort("annotate", { topUpId: row.id }, () =>
        resolveOrEnqueueAnnotation({
          fundId: fund.id,
          chainId: fund.tokenChainId,
          userOpHash: row.mintUserOpHash!,
          kind: ANNOTATION_TRIGGERS.cardTopUp,
          trigger: ANNOTATION_TRIGGERS.cardTopUp,
          triggeredByUserId: null,
        }),
      );
    }
  }
  return true;
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
// Don't keep asking CP about the same PENDING requests forever. SIGNED rows
// are exempt: they are owed a mint whatever their age.
const SWEEP_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
// How far back bank-sync looks for an orphan top-up to adopt a deposit.
const ORPHAN_ADOPT_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
// A MINTED top-up whose deposit hasn't shown up in the bank feed after this
// long is flagged (bounced or reversed transfer?).
const RECONCILE_AFTER_MS = 5 * 24 * 60 * 60 * 1000;
const RECONCILE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export type SweepStats = {
  checked: number;
  minted: number;
  closed: number;
  errors: number;
  // SIGNED top-ups an operator must look at: a claimed mint with no known
  // tx (may or may not be on chain), or retries exhausted.
  stuck: number;
  // MINTED top-ups with no matching bank deposit after RECONCILE_AFTER_MS.
  unreconciled: number;
};

/**
 * Finish top-ups whose member closed the tab, and flag the ones that need a
 * human: re-check PENDING ones older than a minute (signed → mint; expired /
 * cancelled → mark), mint or complete SIGNED ones of any age, expire PENDING
 * ones that never got a request id, and count stuck / unreconciled rows.
 */
export async function sweepCardTopUps(
  fund: TopUpFund,
  now: Date = new Date(),
): Promise<SweepStats> {
  const stats: SweepStats = {
    checked: 0,
    minted: 0,
    closed: 0,
    errors: 0,
    stuck: 0,
    unreconciled: 0,
  };
  const ago = (ms: number) => new Date(now.getTime() - ms);

  const orphans = await prisma.cardTopUp.updateMany({
    where: {
      fundId: fund.id,
      status: "PENDING",
      citizenPayPaymentRequestId: null,
      createdAt: { lt: ago(ORPHAN_EXPIRY_MS) },
    },
    data: { status: "EXPIRED" },
  });
  stats.closed += orphans.count;

  const pending = await prisma.cardTopUp.findMany({
    where: {
      fundId: fund.id,
      status: "PENDING",
      citizenPayPaymentRequestId: { not: null },
      createdAt: { lt: ago(SWEEP_MIN_AGE_MS) },
      updatedAt: { gt: ago(SWEEP_MAX_AGE_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });
  const signed = await prisma.cardTopUp.findMany({
    where: {
      fundId: fund.id,
      status: "SIGNED",
      createdAt: { lt: ago(SWEEP_MIN_AGE_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });

  for (const { id } of [...pending, ...signed]) {
    stats.checked++;
    try {
      const status = await settleCardTopUp(fund, id, now);
      if (status === "minted") stats.minted++;
      else if (status === "expired" || status === "cancelled") stats.closed++;
      else if (status === "signed") {
        const row = await prisma.cardTopUp.findUnique({
          where: { id },
          select: { tokenOperationId: true, mintAttempts: true },
        });
        if (row?.tokenOperationId || (row?.mintAttempts ?? 0) >= MAX_MINT_ATTEMPTS) {
          stats.stuck++;
          console.warn("[card-topup] top-up needs an operator", {
            topUpId: id,
            tokenOperationId: row?.tokenOperationId,
            mintAttempts: row?.mintAttempts,
          });
        }
      }
    } catch (e) {
      stats.errors++;
      console.error("[card-topup] sweep failed", id, e);
    }
  }

  // A MINTED row whose op never got confirmed (bookkeeping failed after the
  // submit) — repair the op from the row's recorded hash.
  const mintedRecently = await prisma.cardTopUp.findMany({
    where: {
      fundId: fund.id,
      status: "MINTED",
      tokenOperationId: { not: null },
      updatedAt: { gt: ago(SWEEP_MAX_AGE_MS) },
    },
    take: 200,
    select: topUpSelect,
  });
  for (const row of mintedRecently) {
    try {
      await completeClaimedMint(fund, row);
    } catch (e) {
      stats.errors++;
      console.error("[card-topup] op repair failed", row.id, e);
    }
  }

  const unreconciled = await prisma.cardTopUp.findMany({
    where: {
      fundId: fund.id,
      status: "MINTED",
      bankTransactionId: null,
      createdAt: { lt: ago(RECONCILE_AFTER_MS), gt: ago(RECONCILE_WINDOW_MS) },
    },
    take: 200,
    select: { id: true, citizenPayPaymentRequestId: true },
  });
  stats.unreconciled = unreconciled.length;
  if (unreconciled.length > 0) {
    console.warn("[card-topup] minted top-ups with no bank deposit yet", {
      fundId: fund.id,
      topUps: unreconciled.map((r) => ({
        id: r.id,
        paymentRequestId: r.citizenPayPaymentRequestId,
      })),
    });
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

export type TopUpDepositClaim =
  | { kind: "topup"; topUpId: string; cardId: string; memberId: string | null }
  // A top-up's deposit we can't take as is: store it unmatched for review and
  // keep it away from member matching (which could tier-mint it on top of
  // the top-up's own credit). `note` goes on BankTransaction.notes.
  | { kind: "hold"; reason: "amount_mismatch" | "duplicate_deposit" | "unverified"; note: string };

/**
 * Is this incoming deposit an open-banking top-up of this fund? Looks up the
 * CardTopUp by the "cp-<id>" remittance; when none carries the id yet (the
 * member never came back from the bank), asks CP what the request was and
 * adopts the matching orphan top-up — or, for a PAY_AND_GO fund, records the
 * top-up from the deposit itself (the money is in the fund's account and CP's
 * request names the card). `live` = the cron (may ask CP and create rows);
 * a backfill only looks up existing rows. `bankTransactionId` = the already
 * mirrored row for this deposit, if any.
 *
 * Returns null when it isn't a top-up of ours (regular matching takes over).
 */
export async function claimTopUpDeposit(
  fund: TopUpFund,
  args: {
    paymentRequestId: number;
    amount: string;
    live: boolean;
    bankTransactionId?: string | null;
  },
): Promise<TopUpDepositClaim | null> {
  const cents = depositCents(args.amount);
  const ref = `cp-${args.paymentRequestId}`;

  const known = await prisma.cardTopUp.findUnique({
    where: {
      fundId_citizenPayPaymentRequestId: {
        fundId: fund.id,
        citizenPayPaymentRequestId: args.paymentRequestId,
      },
    },
    select: {
      id: true,
      cardId: true,
      memberId: true,
      amountCents: true,
      bankTransactionId: true,
    },
  });
  if (known) {
    if (
      known.bankTransactionId &&
      known.bankTransactionId !== (args.bankTransactionId ?? null)
    ) {
      return {
        kind: "hold",
        reason: "duplicate_deposit",
        note: `Card top-up ${ref} already has a bank deposit; this second one was held for review (not credited, not tier-minted).`,
      };
    }
    if (cents == null || known.amountCents !== cents) {
      return {
        kind: "hold",
        reason: "amount_mismatch",
        note: `Card top-up ${ref}: deposit ${args.amount} differs from the top-up (${centsToEuroString(known.amountCents)}). Held for review (not credited, not tier-minted).`,
      };
    }
    return {
      kind: "topup",
      topUpId: known.id,
      cardId: known.cardId,
      memberId: known.memberId,
    };
  }
  if (!args.live) return null;

  const pr = await fetchPaymentRequest(fund, args.paymentRequestId);
  if (!pr || pr.orderId != null || !pr.account) return null;
  const card = await prisma.card.findFirst({
    where: { fundId: fund.id, account: { equals: pr.account, mode: "insensitive" } },
    select: { id: true, account: true, memberId: true },
  });
  if (!card?.account) return null;

  // From here it is a top-up request for one of our cards.
  if (!fund.citizenPayFundId || pr.treasuryId !== fund.citizenPayFundId) {
    return {
      kind: "hold",
      reason: "unverified",
      note: `Card top-up ${ref}: Citizen Pay didn't confirm the request belongs to this fund's treasury. Held for review (not credited, not tier-minted).`,
    };
  }
  if (cents == null || pr.amountCents !== cents) {
    return {
      kind: "hold",
      reason: "amount_mismatch",
      note: `Card top-up ${ref}: deposit ${args.amount} differs from the payment request (${centsToEuroString(pr.amountCents)}). Held for review (not credited, not tier-minted).`,
    };
  }

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
        return { kind: "topup", topUpId: orphan.id, cardId: card.id, memberId: orphan.memberId };
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
      return { kind: "topup", topUpId: created.id, cardId: card.id, memberId: card.memberId };
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
    ? { kind: "topup", topUpId: owner.id, cardId: owner.cardId, memberId: owner.memberId }
    : null;
}

/**
 * Tie the deposit to its top-up. The deposit is proof of payment: on the live
 * cron a top-up not yet minted (still PENDING, or closed EXPIRED / CANCELLED
 * by a CP that lost track of it) moves to SIGNED and is minted here. An
 * already-minted top-up gets the deposit as its mint's source, which also
 * locks the row against re-attribution. `linked: false` = another deposit
 * got there first (the caller must hold this one for review).
 */
export async function linkTopUpDeposit(
  fund: TopUpFund,
  topUpId: string,
  bankTransactionId: string,
  live: boolean,
): Promise<{ linked: boolean; minted: boolean }> {
  await prisma.cardTopUp.updateMany({
    where: { id: topUpId, bankTransactionId: null },
    data: { bankTransactionId },
  });
  let row = await prisma.cardTopUp.findUniqueOrThrow({
    where: { id: topUpId },
    select: topUpSelect,
  });
  if (row.bankTransactionId !== bankTransactionId) {
    return { linked: false, minted: false };
  }

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
    return { linked: true, minted: false };
  }
  if (!live) return { linked: true, minted: false };

  await prisma.cardTopUp.updateMany({
    where: { id: row.id, status: { in: ["PENDING", "EXPIRED", "CANCELLED"] } },
    data: { status: "SIGNED" },
  });
  row = await prisma.cardTopUp.findUniqueOrThrow({
    where: { id: topUpId },
    select: topUpSelect,
  });
  if (row.status !== "SIGNED") return { linked: true, minted: false };
  return { linked: true, minted: (await mintCardTopUp(fund, row)) === "minted" };
}
