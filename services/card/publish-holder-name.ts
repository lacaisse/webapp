// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { publishedHolderName } from "@/services/card/holder-name";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Publish a card's holder name to CitizenPay, which keeps a display name per
// on-chain account and shows it on the public card wallet (tap.citizenpay.eu).
// Called after anything that changes who holds a card or what they're called:
// assign / unassign, a member rename, a card pushed to CP.
//
// Best-effort by design: CP is the display layer, our DB is the record. A
// failure (CP down, serial unknown to CP, or the endpoint not deployed yet —
// 404/405) is logged once and swallowed; it never fails the caller's action.
// `scripts/sync-holder-names.ts` re-publishes everything if CP drifted.

export type PublishHolderNameFund = {
  id: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

// A fund with no CP API key has no treasury to publish to (and live mode
// would throw building the client) — skip it quietly.
function isConnected(fund: PublishHolderNameFund): boolean {
  return Boolean(fund.citizenPayApiKeyId && fund.citizenPayApiKeyEnc);
}

export async function publishCardHolderName(
  fund: PublishHolderNameFund,
  cardId: string,
): Promise<void> {
  if (!isConnected(fund)) return;
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
    if (!card) return;
    await getCitizenPayClient(fund).setCardHolderName(
      card.serialNumber,
      publishedHolderName(card),
    );
  } catch (e) {
    // Status + message only — the error body may echo the name back.
    const detail =
      e instanceof CitizenPayApiError
        ? `${e.status} ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    console.warn(
      `[citizenpay] holder-name publish failed for card ${cardId} (best-effort): ${detail}`,
    );
  }
}

/** Publish each card in turn (sequential — bounded, and keeps CP load flat). */
export async function publishCardHolderNames(
  fund: PublishHolderNameFund,
  cardIds: Iterable<string>,
): Promise<void> {
  if (!isConnected(fund)) return;
  for (const cardId of new Set(cardIds)) {
    await publishCardHolderName(fund, cardId);
  }
}

/** Publish every card a member holds (after a rename). */
export async function publishMemberCardHolderNames(
  fund: PublishHolderNameFund,
  memberId: string,
): Promise<void> {
  if (!isConnected(fund)) return;
  let cards: Array<{ id: string }>;
  try {
    cards = await prisma.card.findMany({
      where: { fundId: fund.id, memberId },
      select: { id: true },
    });
  } catch (e) {
    console.warn(
      `[citizenpay] holder-name publish: loading cards of member ${memberId} failed (best-effort)`,
      e instanceof Error ? e.message : e,
    );
    return;
  }
  await publishCardHolderNames(
    fund,
    cards.map((c) => c.id),
  );
}
