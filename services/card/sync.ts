// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  findForeignCards,
  type ForeignCard,
} from "@/services/card/enrollment-requests";
import { holderDisplayName } from "@/services/card/holder-name";
import { normalizeSerial } from "@/services/card/serial";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type {
  CardStatus as CpCardStatus,
} from "@/services/citizenpay/types";
import type { CardEnrollmentRequestStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";

// Shared helpers for the card-sync flow. Both the preview action (used to
// populate the confirmation dialog) and the run action (which actually
// pushes/pulls) start from `computeCardSyncPlan`. Lives outside the
// `"use server"` file because a server-actions module can only export
// async functions — non-action exports there get silently rewritten into
// remote-callable proxies that explode at runtime.

export type CardSyncPlan = {
  // Local-only cards we need to push to CP (POST /v2/treasury/cards).
  push: Array<{
    cardId: string;
    serialNumber: string;
    holderName: string | null;
  }>;
  // CP-only cards we need to pull into our DB.
  import: Array<{
    serialNumber: string;
    status: CpCardStatus;
    account: string | null;
    createdAt: string;
  }>;
  // CP-only cards whose serial was issued by ANOTHER La Caisse fund (CP lists
  // them because this fund enrolled the card at CP directly, or a bulk
  // enrollment went through before the local create failed). The issuer has
  // to accept before this fund gets a row — the run files a
  // CardEnrollmentRequest instead of importing. Only serials this fund has
  // NO request for yet land here. See `findSerialsAwaitingIssuerAcceptance`.
  requestEnrollment: Array<{
    serialNumber: string;
    card: ForeignCard;
  }>;
  // Same situation, but this fund already filed a request that the issuer
  // has not accepted (PENDING, or decided REJECTED / CANCELLED). The run
  // never touches these — re-filing would flip a decided request back to
  // PENDING and mail the issuer's staff on every sync — so they are shown
  // for information only and do not count as work to do.
  awaitingIssuer: Array<{
    serialNumber: string;
    card: ForeignCard;
    requestStatus: CardEnrollmentRequestStatus;
  }>;
  // Local is authoritative for status — if CP differs, push ours.
  statusUpdate: Array<{
    cardId: string;
    serialNumber: string;
    localStatus: CpCardStatus;
    remoteStatus: CpCardStatus;
  }>;
};

// Minimum fund shape the sync flow needs. Matches what
// `requireFundRole("ADMIN")` returns (full fund row), but we only depend
// on the credential columns for typing.
export type SyncFund = {
  id: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

export type AwaitingAcceptance = {
  card: ForeignCard;
  // This fund's existing request for the card, if any (never ACCEPTED).
  requestStatus: CardEnrollmentRequestStatus | null;
};

/**
 * Among `serials` (already-normalised or not), those issued by another fund
 * that this fund may NOT create a row for yet: the serial is held by another
 * fund (`findForeignCards`) and this fund has no ACCEPTED CardEnrollmentRequest
 * for that card. Keyed by normalised serial. A serial with no foreign owner,
 * or with an ACCEPTED request, is left out — the caller may import it as usual.
 */
export async function findSerialsAwaitingIssuerAcceptance(
  fundId: string,
  serials: string[],
): Promise<Map<string, AwaitingAcceptance>> {
  const out = new Map<string, AwaitingAcceptance>();
  if (serials.length === 0) return out;
  const foreign = await findForeignCards(fundId, serials);
  if (foreign.size === 0) return out;

  const requests = await prisma.cardEnrollmentRequest.findMany({
    where: {
      requesterFundId: fundId,
      cardId: { in: [...foreign.values()].map((c) => c.id) },
    },
    select: { cardId: true, status: true },
  });
  const statusByCardId = new Map(requests.map((r) => [r.cardId, r.status]));

  for (const [serial, card] of foreign) {
    const status = statusByCardId.get(card.id) ?? null;
    if (status === "ACCEPTED") continue;
    out.set(serial, { card, requestStatus: status });
  }
  return out;
}

/**
 * Compute the diff between the local Card table and the CP-side card list
 * for the given fund. Throws if CP is unreachable — the caller decides
 * whether to surface that or fail soft.
 */
export async function computeCardSyncPlan(
  fund: SyncFund,
): Promise<CardSyncPlan> {
  const client = getCitizenPayClient(fund);
  const [remote, local, sourceAccounts] = await Promise.all([
    client.listCitizenPayCards(),
    prisma.card.findMany({
      where: { fundId: fund.id },
      select: {
        id: true,
        serialNumber: true,
        status: true,
        account: true,
        holderName: true,
        sourceSerial: true,
        member: { select: { firstName: true, lastName: true } },
      },
    }),
    // SOURCE token accounts are CP cards too, but they live in
    // FundTokenAccount — not the member-facing Card table. Their serials are
    // excluded from import below so a sync doesn't duplicate them as cards.
    prisma.fundTokenAccount.findMany({
      where: { fundId: fund.id, kind: "SOURCE", serial: { not: null } },
      select: { serial: true },
    }),
  ]);

  const sourceAccountSerials = new Set(
    sourceAccounts.map((a) => normalizeSerial(a.serial!)),
  );

  // Key by NORMALISED serial so a case/whitespace difference between CP and
  // the local row doesn't read as "two different cards" (which would push one
  // and import the other, duplicating it locally).
  const remoteBySerial = new Map(
    remote.cards.map((r) => [normalizeSerial(r.serialNumber), r]),
  );
  const localBySerial = new Map(
    local.map((l) => [normalizeSerial(l.serialNumber), l]),
  );

  const plan: CardSyncPlan = {
    push: [],
    import: [],
    requestEnrollment: [],
    awaitingIssuer: [],
    statusUpdate: [],
  };

  // Heal the local `sourceSerial` display cache while we have both sides in
  // hand. Unlike `status` (local-authoritative, pushed via the plan), the
  // source relationship is CP-authoritative — there's nothing for the admin
  // to decide, so drift is repaired silently rather than surfaced as a plan
  // item. Idempotent; runs on every sync preview.
  const sourceHeals = local.filter((l) => {
    const r = remoteBySerial.get(normalizeSerial(l.serialNumber));
    return r !== undefined && (r.sourceSerial ?? null) !== l.sourceSerial;
  });
  for (const l of sourceHeals) {
    const r = remoteBySerial.get(normalizeSerial(l.serialNumber))!;
    await prisma.card.update({
      where: { id: l.id },
      data: { sourceSerial: r.sourceSerial ?? null },
    });
  }

  for (const l of local) {
    const r = remoteBySerial.get(normalizeSerial(l.serialNumber));
    if (!r) {
      plan.push.push({
        cardId: l.id,
        serialNumber: l.serialNumber,
        holderName: holderDisplayName(l.member, l.holderName),
      });
    } else if (r.status !== l.status) {
      plan.statusUpdate.push({
        cardId: l.id,
        serialNumber: l.serialNumber,
        localStatus: l.status,
        remoteStatus: r.status,
      });
    }
  }

  const cpOnly = remote.cards.filter((r) => {
    const serial = normalizeSerial(r.serialNumber);
    if (sourceAccountSerials.has(serial)) return false; // a source account, not a card
    return !localBySerial.has(serial);
  });
  // A serial another fund issued is theirs to accept — route it to a request
  // rather than a local row (the issuer-acceptance rule the number import and
  // the add-card flow already follow). With a request already on file the
  // serial is only reported (`awaitingIssuer`), never re-requested.
  const awaiting = await findSerialsAwaitingIssuerAcceptance(
    fund.id,
    cpOnly.map((r) => r.serialNumber),
  );
  for (const r of cpOnly) {
    const foreign = awaiting.get(normalizeSerial(r.serialNumber));
    if (foreign) {
      if (foreign.requestStatus === null) {
        plan.requestEnrollment.push({
          serialNumber: r.serialNumber,
          card: foreign.card,
        });
      } else {
        plan.awaitingIssuer.push({
          serialNumber: r.serialNumber,
          card: foreign.card,
          requestStatus: foreign.requestStatus,
        });
      }
      continue;
    }
    // `account` isn't on the list endpoint — the run path fetches it
    // per-card via `getCitizenPayCard`. Preview just shows the count.
    plan.import.push({
      serialNumber: r.serialNumber,
      status: r.status,
      account: null,
      createdAt: r.createdAt,
    });
  }

  return plan;
}
