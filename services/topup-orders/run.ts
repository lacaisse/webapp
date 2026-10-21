// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { centsToEuroString } from "@/services/card-topup/amount";
import { fundCanMint } from "@/services/card-topup/readiness";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import {
  getCitizenPayClient,
  type CitizenPayClient,
  type FundCredentials,
} from "@/services/citizenpay/client";
import type { TopUpOrder, TopUpOrderState } from "@/services/citizenpay/types";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";
import {
  attemptedUserOpHash,
  failedBeforeSubmit,
  getUserOpTx,
  submitBurnFromToken,
  submitMintToken,
  UserOpError,
  type FundMinterContext,
} from "@/services/token/userop";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";

import {
  MAX_TOPUP_ORDERS_PER_RUN,
  opTypeFor,
  planTopUpOrders,
  type TopUpAction,
} from "./plan";

// One run of the terminal top-up settlement for one fund (app/api/cron/topups,
// every minute). Top-up by payment: a member taps a card on a Citizen Pay
// pay-pos terminal and pays by Viva or QR; on a real chain Citizen Pay does
// not mint — it lists the settled order on GET /v2/treasury/topups and the
// issuer (this fund) moves the tokens with its own minter Safe and reports the
// hash. Pending orders are minted to the card; reversal_pending ones (credited
// then refunded) are burned back from it.
//
// Per order: claim (CP's 10-minute lock — a 409 means another attempt holds
// it, skip) → TokenOperation PENDING keyed by the order id → submit the
// userop through the bundler. Acceptance by the bundler IS the success:
// settlement follows within seconds, so the credit / reverse report
// `{claimId, txHash}` goes to CP right away with the userop hash the bundler
// returned (CP keys on userop hashes), and the op keeps that hash as `txHash`
// + `userOpHash`. Every run first resolves the fund's submitted ops against
// the bundler (`getUserOpTx`, as the annotation queue and the reconcile action
// do): settled → CONFIRMED with the mined tx as `txHash`; reverted / timed
// out, or still unknown after STALE_SUBMISSION_MS → FAILED (logged — CP was
// told credited). Only a submission failure (the bundler refused the op, or
// nothing was sent) marks the op FAILED at once, and the order is retried once
// the claim expires. A failed report is logged and resent on a later tick, once
// the op is CONFIRMED (plan.ts "report"); the tokens are never moved twice.
//
// There is no alert channel in this app: failures go to console.error (Vercel
// logs) and to Fund.topUpOrdersRun* for Settings → Token.

export type TopUpRunFund = FundMinterContext &
  FundCredentials & {
    citizenPayFundId: string | null;
    tokenDecimals: number | null;
  };

export type TopUpRunStats = {
  listed: number;
  minted: number; // mint userops the bundler accepted this run
  reversed: number; // burn userops the bundler accepted this run
  reported: number; // report-only resends that landed
  confirmed: number; // earlier submissions resolved to a mined tx this run
  skipped: number;
  failed: number;
  errors: string[];
};

// Injectable seams for the unit test (and nothing else): the CP client and
// the bundler entry points. Prisma is used directly.
export type TopUpRunDeps = {
  client: CitizenPayClient;
  submitMint: typeof submitMintToken;
  submitBurn: typeof submitBurnFromToken;
  resolve: typeof getUserOpTx;
  now: Date;
};

const STATES: TopUpOrderState[] = ["pending", "reversal_pending"];

// A submitted userop the bundler still doesn't resolve after this long never
// made it (a send call that timed out without the bundler taking it): fail the
// op so the order can be retried.
export const STALE_SUBMISSION_MS = 60 * 60 * 1000;

// UserOpError codes raised while building the userop, before anything is
// handed to the bundler (same list as services/card-topup/settle.ts).
const PRE_SUBMIT_CODES: ReadonlySet<string> = new Set([
  "config",
  "fund_not_provisioned",
  "no_token",
  "unsupported_chain",
]);

export async function runTopUpOrders(
  fund: TopUpRunFund,
  overrides: Partial<TopUpRunDeps> = {},
): Promise<TopUpRunStats> {
  const stats: TopUpRunStats = {
    listed: 0,
    minted: 0,
    reversed: 0,
    reported: 0,
    confirmed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  const deps: TopUpRunDeps = {
    client: overrides.client ?? getCitizenPayClient(fund),
    submitMint: overrides.submitMint ?? submitMintToken,
    submitBurn: overrides.submitBurn ?? submitBurnFromToken,
    resolve: overrides.resolve ?? getUserOpTx,
    now: overrides.now ?? new Date(),
  };

  try {
    if (!fund.citizenPayFundId) return stats;
    if (!fundCanMint(fund) || fund.tokenDecimals == null) {
      // Nothing claimed: the orders stay pending on CP until the fund's token
      // and minter are provisioned.
      stats.errors.push("fund cannot mint (token or minter not provisioned)");
      return stats;
    }
    const decimals = fund.tokenDecimals;

    await resolveSubmitted(fund, deps, stats);

    let budget = MAX_TOPUP_ORDERS_PER_RUN;
    for (const state of STATES) {
      let orders: TopUpOrder[];
      try {
        orders = await deps.client.listTopUpOrders(state);
      } catch (e) {
        stats.failed += 1;
        stats.errors.push(`list ${state}: ${errorText(e)}`);
        continue;
      }
      stats.listed += orders.length;
      if (orders.length === 0) continue;

      const localOps = await prisma.tokenOperation.findMany({
        where: {
          fundId: fund.id,
          type: opTypeFor(state),
          topUpOrderId: { in: orders.map((o) => o.orderId) },
        },
        select: {
          id: true,
          type: true,
          status: true,
          txHash: true,
          userOpHash: true,
          topUpOrderId: true,
        },
      });
      const actions = planTopUpOrders(
        orders,
        localOps.map((op) => ({
          ...op,
          type: op.type as "TOPUP" | "TOPUP_REVERSAL",
        })),
        { decimals, limit: budget, now: deps.now },
      );

      for (const action of actions) {
        if (action.kind === "skip") {
          stats.skipped += 1;
          if (action.reason !== "bounded") {
            console.log("[topup-orders] skipped", {
              fundId: fund.id,
              orderId: action.order.orderId,
              reason: action.reason,
            });
          }
          continue;
        }
        budget -= 1;
        try {
          await settleOne(fund, deps, action, stats);
        } catch (e) {
          // Guard against a bug in the bookkeeping: one order must never
          // stop the others.
          stats.failed += 1;
          stats.errors.push(`order ${action.order.orderId}: ${errorText(e)}`);
          console.error("[topup-orders] order failed", {
            fundId: fund.id,
            orderId: action.order.orderId,
            error: e,
          });
        }
      }
    }
  } finally {
    await bestEffort("record run", { fundId: fund.id }, () =>
      prisma.fund.update({
        where: { id: fund.id },
        data: {
          topUpOrdersRunAt: deps.now,
          topUpOrdersRunMinted: stats.minted,
          topUpOrdersRunReversed: stats.reversed,
          topUpOrdersRunFailed: stats.failed,
          topUpOrdersRunError: stats.errors[0]?.slice(0, 500) ?? null,
        },
      }),
    );
  }
  return stats;
}

// Resolve the fund's submitted top-up userops (PENDING with a hash) against
// the bundler. Settled → CONFIRMED and the mined tx replaces the userop hash
// (kept on `userOpHash`); reverted / timed out, or unknown for too long →
// FAILED. Failures here are logged and counted — CP was already told
// credited, so an operator has to look.
async function resolveSubmitted(
  fund: TopUpRunFund,
  deps: TopUpRunDeps,
  stats: TopUpRunStats,
): Promise<void> {
  const ops = await prisma.tokenOperation.findMany({
    where: {
      fundId: fund.id,
      type: { in: ["TOPUP", "TOPUP_REVERSAL"] },
      status: "PENDING",
      txHash: { not: null },
    },
    orderBy: { submittedAt: "asc" },
    take: 50,
    select: { id: true, txHash: true, submittedAt: true, topUpOrderId: true },
  });

  for (const op of ops) {
    if (!op.txHash) continue;
    const ids = { fundId: fund.id, orderId: op.topUpOrderId, opId: op.id };
    let res: Awaited<ReturnType<typeof getUserOpTx>>;
    try {
      res = await deps.resolve(fund.tokenChainId, op.txHash);
    } catch (e) {
      console.warn("[topup-orders] resolve failed; next tick", ids, e);
      continue;
    }

    if (res.status === "success" && res.txHash) {
      const minedTx = res.txHash;
      try {
        await prisma.tokenOperation.update({
          where: { id: op.id },
          data: { status: "CONFIRMED", txHash: minedTx, confirmedAt: new Date() },
        });
      } catch (e) {
        // Two userops of one bundle settle in the same tx, and `txHash` is
        // unique: keep the userop hash on this row (still CONFIRMED).
        if (!isUniqueViolation(e)) throw e;
        await prisma.tokenOperation.update({
          where: { id: op.id },
          data: { status: "CONFIRMED", confirmedAt: new Date() },
        });
        console.warn("[topup-orders] mined tx shared with another op", {
          ...ids,
          txHash: minedTx,
        });
      }
      stats.confirmed += 1;
      continue;
    }

    const stale =
      deps.now.getTime() - op.submittedAt.getTime() > STALE_SUBMISSION_MS;
    if (res.status === "reverted" || res.status === "timeout" || stale) {
      const errorMessage =
        res.status === "reverted" || res.status === "timeout"
          ? `userop ${res.status} on chain [userOp ${op.txHash}]`
          : `userop not settled after ${STALE_SUBMISSION_MS / 60_000} min [userOp ${op.txHash}]`;
      await bestEffort("fail op", ids, () =>
        prisma.tokenOperation.update({
          where: { id: op.id },
          data: { status: "FAILED", errorMessage },
        }),
      );
      stats.failed += 1;
      stats.errors.push(`order ${op.topUpOrderId}: ${errorMessage}`);
      console.error("[topup-orders] submitted userop did not settle", {
        ...ids,
        status: res.status,
        txHash: res.txHash,
      });
    }
    // Still pending / submitted and young: next tick.
  }
}

async function settleOne(
  fund: TopUpRunFund,
  deps: TopUpRunDeps,
  action: Exclude<TopUpAction, { kind: "skip" }>,
  stats: TopUpRunStats,
): Promise<void> {
  const { order } = action;
  const ids = { fundId: fund.id, orderId: order.orderId };

  // 1. Claim — CP's lock between concurrent runs.
  let claimId: string;
  try {
    claimId = (await deps.client.claimTopUpOrder(order.orderId)).claimId;
  } catch (e) {
    if (e instanceof CitizenPayApiError && e.status === 409) {
      // `claim in progress` → another attempt holds it; `already credited` /
      // `not pending` → CP settled it between the list and the claim.
      stats.skipped += 1;
      console.log("[topup-orders] claim refused", { ...ids, error: e.message });
      return;
    }
    throw e;
  }

  // 2. A report-only resend: the userop already settled in an earlier run.
  if (action.kind === "report") {
    const ok = await report(deps, order, { claimId, txHash: action.txHash }, stats, ids);
    if (ok) stats.reported += 1;
    return;
  }

  // 3. Record, then hand the userop to the bundler.
  const card = await prisma.card.findFirst({
    where: {
      fundId: fund.id,
      account: { equals: order.cardAddress, mode: "insensitive" },
    },
    select: { memberId: true },
  });
  const type = action.kind === "mint" ? "TOPUP" : "TOPUP_REVERSAL";
  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type,
      memberId: card?.memberId ?? null,
      account: order.cardAddress,
      amount: centsToEuroString(order.amountCents),
      status: "PENDING",
      topUpOrderId: order.orderId,
      topUpSerial: order.serial,
      topUpPlaceName: order.placeName,
    },
    select: { id: true },
  });

  let userOpHash: string;
  try {
    ({ userOpHash } =
      action.kind === "mint"
        ? await deps.submitMint({
            fund,
            to: order.cardAddress as `0x${string}`,
            amount: action.units,
          })
        : await deps.submitBurn({
            fund,
            from: order.cardAddress as `0x${string}`,
            amount: action.units,
          }));
  } catch (e) {
    await recordSubmitFailure(op.id, e, ids);
    stats.failed += 1;
    stats.errors.push(`order ${order.orderId}: ${errorText(e)}`);
    return;
  }

  // Accepted by the bundler: the top-up is done from CP's point of view.
  // Only bookkeeping from here on — logged, never thrown, never FAILED.
  await bestEffort("record userop", { ...ids, opId: op.id }, () =>
    prisma.tokenOperation.update({
      where: { id: op.id },
      data: { txHash: userOpHash, userOpHash },
    }),
  );
  if (action.kind === "mint") stats.minted += 1;
  else stats.reversed += 1;

  await report(deps, order, { claimId, txHash: userOpHash }, stats, ids);

  const trigger =
    action.kind === "mint"
      ? ANNOTATION_TRIGGERS.terminalTopUp
      : ANNOTATION_TRIGGERS.terminalTopUpReversal;
  await bestEffort("annotate", { ...ids, opId: op.id }, () =>
    resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: trigger,
      note: order.placeName
        ? `Top-up order ${order.orderId} at ${order.placeName}`
        : `Top-up order ${order.orderId}`,
      trigger,
      triggeredByUserId: null,
    }),
  );
}

// Tell CP the tokens are on their way (userop hash). A 409 `already credited`
// means an earlier report landed — done. Any other failure is logged and
// counted; once the op is CONFIRMED the next tick resends just the report.
async function report(
  deps: TopUpRunDeps,
  order: TopUpOrder,
  body: { claimId: string; txHash: string },
  stats: TopUpRunStats,
  ids: { fundId: string; orderId: number },
): Promise<boolean> {
  try {
    if (order.state === "pending") {
      await deps.client.creditTopUpOrder(order.orderId, body);
    } else {
      await deps.client.reverseTopUpOrder(order.orderId, body);
    }
    return true;
  } catch (e) {
    if (
      e instanceof CitizenPayApiError &&
      e.status === 409 &&
      /already (credited|reversed)/.test(e.message)
    ) {
      return true;
    }
    stats.failed += 1;
    stats.errors.push(`order ${order.orderId} report: ${errorText(e)}`);
    console.error("[topup-orders] report failed (resent next tick)", {
      ...ids,
      txHash: body.txHash,
      error: e,
    });
    return false;
  }
}

// The bundler did not take the userop — or the call to it failed. Nothing
// sent (tagged pre-submit, a build-time code, or no attempted hash) → FAILED,
// retried once the claim expires. A send call that failed after the userop
// was signed and handed over may still have been accepted: keep the attempt's
// hash on the row and let `resolveSubmitted` decide (settled → CONFIRMED and
// reported on the next tick; unknown for STALE_SUBMISSION_MS → FAILED).
async function recordSubmitFailure(
  opId: string,
  e: unknown,
  ids: { fundId: string; orderId: number },
): Promise<void> {
  const userOpHash = attemptedUserOpHash(e);
  const preSubmit =
    failedBeforeSubmit(e) ||
    (e instanceof UserOpError && PRE_SUBMIT_CODES.has(e.code)) ||
    !userOpHash;
  const errorMessage =
    (e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e)) +
    (userOpHash ? ` [userOp ${userOpHash}]` : "");
  console.error("[topup-orders] submit failed", {
    ...ids,
    opId,
    preSubmit,
    userOpHash,
    error: errorMessage,
  });
  await bestEffort("mark op", { ...ids, opId }, () =>
    prisma.tokenOperation.update({
      where: { id: opId },
      data: preSubmit
        ? { status: "FAILED", errorMessage }
        : { errorMessage, txHash: userOpHash, userOpHash },
    }),
  );
}

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

async function bestEffort(
  label: string,
  ids: object,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[topup-orders] ${label} failed`, ids, e);
  }
}

function errorText(e: unknown): string {
  if (e instanceof UserOpError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
