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
import { prisma } from "@/services/db/prisma";
import {
  attemptedUserOpHash,
  burnFromToken,
  failedBeforeSubmit,
  mintToken,
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
// it, skip) → TokenOperation PENDING keyed by the order id → mint / burn via
// the shared userop path → op CONFIRMED with the tx hash → credit / reverse
// report with {claimId, txHash}. Anything after the userop resolved is
// bookkeeping: logged, never thrown, never FAILED — the next tick finds the
// CONFIRMED op and only resends the report (plan.ts "report"). A failure
// before the userop was sent marks the op FAILED and the order is retried
// once the claim expires; a failure that may have reached the chain keeps the
// op PENDING with the userop hash in its error text, and plan.ts leaves the
// order to an operator (ReconcileOperationButton on the member page).
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
  minted: number;
  reversed: number;
  reported: number; // report-only resends that landed
  skipped: number;
  failed: number;
  errors: string[];
};

// Injectable seams for the unit test (and nothing else): the CP client and
// the two userop entry points. Prisma is used directly.
export type TopUpRunDeps = {
  client: CitizenPayClient;
  mint: typeof mintToken;
  burn: typeof burnFromToken;
  now: Date;
};

const STATES: TopUpOrderState[] = ["pending", "reversal_pending"];

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
    skipped: 0,
    failed: 0,
    errors: [],
  };
  const deps: TopUpRunDeps = {
    client: overrides.client ?? getCitizenPayClient(fund),
    mint: overrides.mint ?? mintToken,
    burn: overrides.burn ?? burnFromToken,
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

  // 2. A report-only resend: the tokens moved in an earlier run.
  if (action.kind === "report") {
    const ok = await report(deps, order, { claimId, txHash: action.txHash }, stats, ids);
    if (ok) stats.reported += 1;
    return;
  }

  // 3. Record, then move the tokens.
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

  let moved: { txHash: string; userOpHash: string };
  try {
    moved =
      action.kind === "mint"
        ? await deps.mint({
            fund,
            to: order.cardAddress as `0x${string}`,
            amount: action.units,
          })
        : await deps.burn({
            fund,
            from: order.cardAddress as `0x${string}`,
            amount: action.units,
          });
  } catch (e) {
    await recordFailure(op.id, e, ids);
    stats.failed += 1;
    stats.errors.push(`order ${order.orderId}: ${errorText(e)}`);
    return;
  }

  // Submitted and confirmed by the bundler: only bookkeeping from here on.
  await bestEffort("confirm op", { ...ids, opId: op.id }, () =>
    prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash: moved.txHash, confirmedAt: new Date() },
    }),
  );
  if (action.kind === "mint") stats.minted += 1;
  else stats.reversed += 1;

  await report(deps, order, { claimId, txHash: moved.txHash }, stats, ids);

  const trigger =
    action.kind === "mint"
      ? ANNOTATION_TRIGGERS.terminalTopUp
      : ANNOTATION_TRIGGERS.terminalTopUpReversal;
  await bestEffort("annotate", { ...ids, opId: op.id }, () =>
    resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash: moved.userOpHash,
      kind: trigger,
      note: order.placeName
        ? `Top-up order ${order.orderId} at ${order.placeName}`
        : `Top-up order ${order.orderId}`,
      trigger,
      triggeredByUserId: null,
    }),
  );
}

// Tell CP the tokens moved. A 409 `already credited` means an earlier report
// landed — done. Any other failure is logged and counted; the CONFIRMED op
// makes the next tick resend just the report.
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

async function recordFailure(
  opId: string,
  e: unknown,
  ids: { fundId: string; orderId: number },
): Promise<void> {
  const userOpHash = attemptedUserOpHash(e);
  const preSubmit =
    failedBeforeSubmit(e) ||
    (e instanceof UserOpError && PRE_SUBMIT_CODES.has(e.code));
  const errorMessage =
    (e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e)) +
    (userOpHash ? ` [userOp ${userOpHash}]` : "");
  console.error("[topup-orders] userop failed", {
    ...ids,
    opId,
    preSubmit,
    userOpHash,
    error: errorMessage,
  });
  // Nothing was sent → FAILED, retried once the claim expires. Possibly on
  // chain → stays PENDING (plan.ts "in_flight") for an operator to reconcile;
  // minting again blind could credit the card twice.
  await bestEffort("mark op", { ...ids, opId }, () =>
    prisma.tokenOperation.update({
      where: { id: opId },
      data: preSubmit ? { status: "FAILED", errorMessage } : { errorMessage },
    }),
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
