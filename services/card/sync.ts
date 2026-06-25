// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { normalizeSerial } from "@/services/card/serial";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type {
  CardStatus as CpCardStatus,
} from "@/services/citizenpay/types";
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

  const plan: CardSyncPlan = { push: [], import: [], statusUpdate: [] };

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
        holderName:
          l.holderName ||
          (l.member
            ? `${l.member.firstName} ${l.member.lastName}`.trim()
            : null),
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

  for (const r of remote.cards) {
    const serial = normalizeSerial(r.serialNumber);
    if (sourceAccountSerials.has(serial)) continue; // a source account, not a card
    if (!localBySerial.has(serial)) {
      // `account` isn't on the list endpoint — the run path fetches it
      // per-card via `getCitizenPayCard`. Preview just shows the count.
      plan.import.push({
        serialNumber: r.serialNumber,
        status: r.status,
        account: null,
        createdAt: r.createdAt,
      });
    }
  }

  return plan;
}
