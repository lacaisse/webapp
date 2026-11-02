// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";
import type { FundConversion, FundConversionStatus, Prisma } from "@/services/db/generated/client";

import { assetChainId } from "./assets";
import { converterById } from "./registry";
import {
  ConvertError,
  type Address,
  type ConversionState,
  type Hex,
  type StepResult,
} from "./types";
import { legContext, walk, type Walk } from "./walk";

// How a conversion moves once something happened to it: its Safe proposal
// executed (recordExecuted), was withdrawn or superseded (withdrawProposal,
// sync), or its order filled (the cron polling the swap leg). This module
// never creates Safe proposals — engine.ts does — so proposals.ts can import
// it without a cycle. Module map: services/convert/assets.ts.
//
// Every status move is a guarded updateMany on the status the row had when
// it was read: two pollers, or a hook racing the cron, cannot both record
// the same result (services/card-topup/settle.ts pattern).

export type ConversionRow = FundConversion;

export function stateOf(row: Pick<ConversionRow, "state" | "id">): ConversionState {
  const s = row.state as Partial<ConversionState> | null;
  if (!s || !Array.isArray(s.legs)) {
    throw new ConvertError("invalid_state", `Conversion ${row.id} has no leg state`);
  }
  return { legs: s.legs };
}

export function walkRow(row: ConversionRow, state: ConversionState, now: Date): Walk {
  return walk({
    converter: converterById(row.converterId),
    chainId: assetChainId(row.fromAsset as Parameters<typeof assetChainId>[0]),
    holder: row.holderAddress as Address,
    amountIn: BigInt(row.amountIn),
    state,
    now,
  });
}

/**
 * Run the `api` steps at the current position until the conversion waits on
 * something else (a batch, a fill) or is done. Mutates `state`. Used by the
 * engine at start and by the hooks below when a later leg opens with one.
 */
export async function runApiSteps(a: {
  converterId: string;
  chainId: number;
  holder: Address;
  amountIn: bigint;
  state: ConversionState;
  now: Date;
}): Promise<Walk> {
  const converter = converterById(a.converterId);
  for (let guard = 0; guard < 8; guard++) {
    const w = walk({ converter, ...a });
    if (w.done || w.position.step.kind !== "api") return w;
    const { legIndex, amountIn } = w.position;
    const leg = converter.legs[legIndex];
    if (!leg.run) throw new ConvertError("invalid_state", `Leg ${leg.id} has an api step but no run()`);
    const result = await leg.run(legContext({ ...a, amountIn, legIndex }));
    for (const i of w.position.appliesTo) a.state.legs[i].results.push(result);
  }
  throw new ConvertError("invalid_state", "Conversion does not settle after its api steps");
}

type NextStatus =
  | { status: "FILLING" }
  | { status: "READY" }
  | { status: "DONE"; amountOut: bigint };

export function statusAfter(w: Walk): NextStatus {
  if (w.done) return { status: "DONE", amountOut: w.amountOut };
  if (w.position.step.kind === "wait") return { status: "FILLING" };
  if (w.position.step.kind === "calls") return { status: "READY" };
  throw new ConvertError("invalid_state", "An api step is still pending");
}

// Record `result` on the legs `appliesTo`, run any api step that follows,
// and move the row from `from` to what the walk says. False when another
// writer moved the row first.
async function recordAndAdvance(a: {
  row: ConversionRow;
  state: ConversionState;
  appliesTo: number[];
  result: StepResult;
  from: FundConversionStatus;
  now: Date;
}): Promise<boolean> {
  const { row, state } = a;
  for (const i of a.appliesTo) state.legs[i].results.push(a.result);
  const w = await runApiSteps({
    converterId: row.converterId,
    chainId: assetChainId(row.fromAsset as Parameters<typeof assetChainId>[0]),
    holder: row.holderAddress as Address,
    amountIn: BigInt(row.amountIn),
    state,
    now: a.now,
  });
  const next = statusAfter(w);
  const data: Prisma.FundConversionUpdateManyMutationInput = {
    state: state as unknown as Prisma.InputJsonValue,
    status: next.status,
    errorMessage: null,
    ...(next.status === "DONE" ? { amountOut: next.amountOut.toString(), completedAt: a.now } : {}),
  };
  const res = await prisma.fundConversion.updateMany({
    where: { id: row.id, fundId: row.fundId, status: a.from },
    data,
  });
  return res.count === 1;
}

async function fail(row: ConversionRow, from: FundConversionStatus, status: "EXPIRED" | "FAILED", message: string | null, now: Date) {
  await prisma.fundConversion.updateMany({
    where: { id: row.id, fundId: row.fundId, status: from },
    data: { status, errorMessage: message, completedAt: now },
  });
}

// ---------------------------------------------------------------------------
// Hooks from the Safe core
// ---------------------------------------------------------------------------

/** The conversion's current Safe proposal executed: record the batch, move on. */
export async function onConversionTxExecuted(a: {
  fundId: string;
  conversionId: string;
  txHash: Hex | null;
  now?: Date;
}): Promise<void> {
  const now = a.now ?? new Date();
  const row = await prisma.fundConversion.findFirst({ where: { id: a.conversionId, fundId: a.fundId } });
  if (!row || row.status !== "PROPOSED") return; // already moved (hook + cron)
  const state = stateOf(row);
  const w = walkRow(row, state, now);
  if (w.done || w.position.step.kind !== "calls") {
    console.warn("[convert] executed proposal but no calls step pending", row.id, w);
    return;
  }
  await recordAndAdvance({
    row,
    state,
    appliesTo: w.position.appliesTo,
    result: { kind: "calls", txHash: a.txHash },
    from: "PROPOSED",
    now,
  });
}

/** The conversion's current Safe proposal is gone (withdrawn / superseded / reverted): back to READY. */
export async function onConversionProposalGone(a: { fundId: string; conversionId: string }): Promise<void> {
  await prisma.fundConversion.updateMany({
    where: { id: a.conversionId, fundId: a.fundId, status: "PROPOSED" },
    data: { status: "READY" },
  });
}

// ---------------------------------------------------------------------------
// Polling (cron, and the Safe page on view)
// ---------------------------------------------------------------------------

export type PollOutcome = "pending" | "filled" | "expired" | "failed" | "moved";

export async function pollConversion(row: ConversionRow, now = new Date()): Promise<PollOutcome> {
  if (row.status !== "FILLING") return "moved";
  const state = stateOf(row);
  const w = walkRow(row, state, now);
  if (w.done || w.position.step.kind !== "wait") {
    // Status and state disagree (a crash between two writes): let the walk decide.
    const next = statusAfter(w);
    await prisma.fundConversion.updateMany({
      where: { id: row.id, fundId: row.fundId, status: "FILLING" },
      data: {
        status: next.status,
        ...(next.status === "DONE" ? { amountOut: next.amountOut.toString(), completedAt: now } : {}),
      },
    });
    return "moved";
  }
  const converter = converterById(row.converterId);
  const { legIndex, amountIn, appliesTo } = w.position;
  const leg = converter.legs[legIndex];
  if (!leg.poll) throw new ConvertError("invalid_state", `Leg ${leg.id} has a wait step but no poll()`);
  const ctx = legContext({
    chainId: assetChainId(row.fromAsset as Parameters<typeof assetChainId>[0]),
    holder: row.holderAddress as Address,
    amountIn,
    state,
    legIndex,
    now,
  });
  const res = await leg.poll(ctx);
  switch (res.status) {
    case "pending":
      return "pending";
    case "filled": {
      const moved = await recordAndAdvance({ row, state, appliesTo, result: res.result, from: "FILLING", now });
      return moved ? "filled" : "moved";
    }
    case "expired":
      await fail(row, "FILLING", "EXPIRED", null, now);
      return "expired";
    case "failed":
      await fail(row, "FILLING", "FAILED", res.reason, now);
      return "failed";
  }
}

/**
 * Poll one Safe's FILLING conversions — the Safe page on view, so a fill
 * shows without waiting for the cron. Best effort: errors are logged.
 */
export async function pollSafeConversions(fundId: string, safeId: string, now = new Date()): Promise<void> {
  const rows = await prisma.fundConversion.findMany({
    where: { fundId, safeId, status: "FILLING" },
    orderBy: { updatedAt: "asc" },
    take: 10,
  });
  for (const row of rows) {
    try {
      await pollConversion(row, now);
    } catch (e) {
      console.warn("[convert] poll on view failed", row.id, e instanceof Error ? e.message : e);
    }
  }
}

const POLL_BATCH = 50;
// A PROPOSED row untouched this long is checked against its Safe transaction
// in case the execution / withdrawal hook never ran.
const REPAIR_AFTER_MS = 2 * 60 * 1000;

export type AdvanceSummary = {
  polled: number;
  filled: number;
  expired: number;
  failed: number;
  repaired: number;
  errors: string[];
};

/** The cron tick: poll FILLING rows, repair PROPOSED rows whose hook was missed. */
export async function advanceConversions(now = new Date()): Promise<AdvanceSummary> {
  const out: AdvanceSummary = { polled: 0, filled: 0, expired: 0, failed: 0, repaired: 0, errors: [] };

  const filling = await prisma.fundConversion.findMany({
    where: { status: "FILLING" },
    orderBy: { updatedAt: "asc" },
    take: POLL_BATCH,
  });
  for (const row of filling) {
    try {
      const r = await pollConversion(row, now);
      out.polled++;
      if (r === "filled") out.filled++;
      else if (r === "expired") out.expired++;
      else if (r === "failed") out.failed++;
    } catch (e) {
      out.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      console.error("[convert] poll failed", row.id, e);
    }
  }

  const proposed = await prisma.fundConversion.findMany({
    where: { status: "PROPOSED", updatedAt: { lt: new Date(now.getTime() - REPAIR_AFTER_MS) } },
    orderBy: { updatedAt: "asc" },
    take: POLL_BATCH,
  });
  for (const row of proposed) {
    try {
      const txs = await prisma.fundSafeTransaction.findMany({
        where: { conversionId: row.id },
        select: { status: true, txHash: true, executedAt: true },
        orderBy: { createdAt: "asc" },
      });
      const live = txs.some((t) => t.status === "PENDING" || t.status === "EXECUTING" || t.status === "FAILED");
      if (live) continue; // still collecting signatures / retryable
      const executed = txs.filter((t) => t.status === "EXECUTED");
      if (executed.length >= row.round) {
        // The current step executed and the hook was missed.
        const last = executed[executed.length - 1];
        await onConversionTxExecuted({ fundId: row.fundId, conversionId: row.id, txHash: last.txHash as Hex | null, now });
      } else {
        // No proposal left for this step: hand it back.
        await onConversionProposalGone({ fundId: row.fundId, conversionId: row.id });
      }
      out.repaired++;
    } catch (e) {
      out.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      console.error("[convert] repair failed", row.id, e);
    }
  }
  return out;
}
