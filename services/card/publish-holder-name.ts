// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { after } from "next/server";

import { publishedHolderName } from "@/services/card/holder-name";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Publish a card's holder name to CitizenPay, which keeps a display name per
// on-chain account and shows it on the public card wallet (tap.citizenpay.eu).
// Triggered by anything that changes who holds a card or what they're called:
// assign / unassign, a member rename (profile edit or CSV import), a card
// pushed to CP.
//
// Best-effort and OFF the request path: actions call the `schedule*` helpers,
// which defer the work with `after()` so the user's response never waits on CP
// (each PUT also has a 3 s timeout, see api.ts `cards.setHolderName`). Our DB
// is the record; CP is the display layer. A failure (CP down, serial unknown to
// CP, or the endpoint not deployed yet — 404/405) is logged as a status code
// with a fixed message — never CP's error text (it can echo the name) nor the
// serial — and swallowed. `scripts/sync-holder-names.ts` re-publishes in bulk.

export type PublishHolderNameFund = {
  id: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

// "ok", "skipped" (unconnected fund / card not in the fund), or a failure
// code: the HTTP status, "network" (unreachable / timed out), or "error".
export type PublishOutcome = "ok" | "skipped" | string;

const DEFAULT_CONCURRENCY = 4;

// A fund with no CP API key has no treasury to publish to (and live mode
// would throw building the client) — skip it quietly.
function isConnected(fund: PublishHolderNameFund): boolean {
  return Boolean(fund.citizenPayApiKeyId && fund.citizenPayApiKeyEnc);
}

function failureCode(e: unknown): string {
  if (e instanceof CitizenPayApiError) return String(e.status);
  // fetch rejects with a TypeError when the host is unreachable, and the
  // request timeout aborts with AbortError / TimeoutError.
  if (
    e instanceof Error &&
    (e.name === "AbortError" || e.name === "TimeoutError" || e instanceof TypeError)
  ) {
    return "network";
  }
  return "error";
}

const isFailure = (o: PublishOutcome) => o !== "ok" && o !== "skipped";

// One card, no logging, never throws.
async function publishOne(
  fund: PublishHolderNameFund,
  cardId: string,
): Promise<PublishOutcome> {
  try {
    const card = await prisma.card.findFirst({
      where: { id: cardId, fundId: fund.id },
      select: {
        serialNumber: true,
        memberId: true,
        holderName: true,
        member: { select: { firstName: true, lastName: true } },
      },
    });
    if (!card) return "skipped";
    await getCitizenPayClient(fund).setCardHolderName(
      card.serialNumber,
      publishedHolderName(card),
    );
    return "ok";
  } catch (e) {
    return failureCode(e);
  }
}

/** Publish one card now (awaited). Logs once on failure; never throws. */
export async function publishCardHolderName(
  fund: PublishHolderNameFund,
  cardId: string,
): Promise<PublishOutcome> {
  if (!isConnected(fund)) return "skipped";
  const outcome = await publishOne(fund, cardId);
  if (isFailure(outcome)) {
    console.warn(
      `[citizenpay] holder-name publish failed (best-effort): ${outcome}`,
    );
  }
  return outcome;
}

export type PublishSummary = {
  ok: number;
  failed: number;
  // Cards never attempted because a network failure stopped the run.
  notAttempted: number;
};

/**
 * Publish several cards now (awaited) with bounded concurrency. Stops picking
 * up new cards after the first network failure — CP is unreachable, so the
 * rest would only time out one by one. One summary log line for the batch.
 */
export async function publishCardHolderNames(
  fund: PublishHolderNameFund,
  cardIds: Iterable<string>,
  opts: { concurrency?: number } = {},
): Promise<PublishSummary> {
  const queue = [...new Set(cardIds)];
  const summary: PublishSummary = { ok: 0, failed: 0, notAttempted: 0 };
  if (!isConnected(fund) || queue.length === 0) return summary;

  const byCode = new Map<string, number>();
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < queue.length) {
      const outcome = await publishOne(fund, queue[next++]);
      if (outcome === "ok") summary.ok++;
      else if (isFailure(outcome)) {
        summary.failed++;
        byCode.set(outcome, (byCode.get(outcome) ?? 0) + 1);
        if (outcome === "network") stopped = true;
      }
    }
  };
  const workers = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  summary.notAttempted = queue.length - next;

  if (summary.failed > 0) {
    const codes = [...byCode].map(([c, n]) => `${c}×${n}`).join(", ");
    console.warn(
      `[citizenpay] holder-name publish failed for ${summary.failed}/${queue.length} card(s) (best-effort): ${codes}` +
        (summary.notAttempted > 0
          ? `; stopped after a network failure, ${summary.notAttempted} not attempted`
          : ""),
    );
  }
  return summary;
}

// Only the credential columns are captured by the deferred callback, not the
// caller's whole fund row.
function credsOf(fund: PublishHolderNameFund): PublishHolderNameFund {
  return {
    id: fund.id,
    citizenPayApiKeyId: fund.citizenPayApiKeyId,
    citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
  };
}

/**
 * Publish the given cards after the response is sent (`after()`), so a slow or
 * missing CP endpoint never delays the user's action. Call from server actions.
 */
export function scheduleCardHolderNamePublish(
  fund: PublishHolderNameFund,
  cardIds: string | Iterable<string>,
): void {
  if (!isConnected(fund)) return;
  const ids = typeof cardIds === "string" ? [cardIds] : [...cardIds];
  if (ids.length === 0) return;
  const f = credsOf(fund);
  after(async () => {
    await publishCardHolderNames(f, ids);
  });
}

/**
 * Carry a member rename onto their cards. `Card.holderName` is stamped with the
 * member's full name at assignment, so the cards still holding the OLD full
 * name get the new one. A card under any other name is left alone: a
 * dependant's card, or one still carrying a name from a rename made before
 * this ran (stale — see scripts/sync-holder-names.ts).
 *
 * Returns the ids whose public name the rename changes — the rewritten cards
 * plus unnamed ones (they display the member's name) — i.e. what to publish.
 */
export async function renameStampedHolderNames(input: {
  fundId: string;
  memberId: string;
  oldName: string;
  newName: string;
}): Promise<string[]> {
  const oldName = input.oldName.trim();
  const newName = input.newName.trim();
  if (oldName === newName) return [];
  const affected = await prisma.card.findMany({
    where: {
      fundId: input.fundId,
      memberId: input.memberId,
      OR: [{ holderName: null }, { holderName: "" }, ...(oldName ? [{ holderName: oldName }] : [])],
    },
    select: { id: true, holderName: true },
  });
  const rewrite = affected.filter((c) => oldName && c.holderName === oldName);
  if (rewrite.length > 0 && newName) {
    await prisma.card.updateMany({
      where: { id: { in: rewrite.map((c) => c.id) }, holderName: oldName },
      data: { holderName: newName },
    });
  }
  return affected.map((c) => c.id);
}
