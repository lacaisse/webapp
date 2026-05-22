// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Typeahead backing the /token mint and burn dialogs. Surfaces local
// entities the operator is most likely to mean by serial / name, so a
// raw address is only required when the recipient is an external wallet.
//
// Only entries with a non-null on-chain account are returned — without
// one there is no address to mint to or burn from.
//
// Places come from CP's `listPlaces` (the source of truth for accounts)
// re-labelled with the local Merchant name when one exists, so a place
// is searchable even when the local Merchant hasn't been fully synced
// yet (or doesn't exist at all).

export type RecipientHit =
  | {
      kind: "card";
      id: string;
      account: string;
      label: string;
      sublabel: string | null;
    }
  | {
      kind: "place";
      id: string;
      account: string;
      label: string;
      sublabel: string | null;
    };

const LIMIT = 8;

export async function searchTokenRecipientsAction(
  q: string,
): Promise<RecipientHit[]> {
  const { fund } = await requireFundRole("ADMIN");
  const term = q.trim();
  if (term.length < 2) return [];

  const insensitive = { contains: term, mode: "insensitive" as const };
  const termLower = term.toLowerCase();

  const [cards, localMerchants, cpPlacesResult] = await Promise.all([
    prisma.card.findMany({
      where: {
        fundId: fund.id,
        account: { not: null },
        OR: [
          { serialNumber: insensitive },
          { holderName: insensitive },
          { member: { firstName: insensitive } },
          { member: { lastName: insensitive } },
        ],
      },
      select: {
        id: true,
        account: true,
        serialNumber: true,
        holderName: true,
        member: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    }),
    // Every local Merchant with CP linkage. We use this to re-label CP
    // places with the local name when there's a mapping, and to fall
    // back on local rows when CP is unreachable.
    prisma.merchant.findMany({
      where: { fundId: fund.id },
      select: {
        id: true,
        name: true,
        citizenPayPlaceId: true,
        citizenPayPlaceAccount: true,
      },
    }),
    fetchCpPlaces(fund),
  ]);

  const hits: RecipientHit[] = [];

  for (const c of cards) {
    if (!c.account) continue;
    const memberName = c.member
      ? `${c.member.firstName} ${c.member.lastName}`.trim()
      : "";
    const label = c.holderName?.trim() || memberName || c.serialNumber;
    // Always surface the serial as a sublabel — that's what's printed on
    // the physical card, the only stable handle the operator has.
    const sublabel = label === c.serialNumber ? null : c.serialNumber;
    hits.push({
      kind: "card",
      id: c.id,
      account: c.account,
      label,
      sublabel,
    });
  }

  // Build place rows: take CP as the universe (it owns the account),
  // re-label with the local Merchant name when we have one. Fall back
  // to scanning local merchants when CP is unavailable.
  const merchantByPlaceId = new Map<string, { id: string; name: string }>();
  const merchantByAccount = new Map<string, { id: string; name: string }>();
  for (const m of localMerchants) {
    if (m.citizenPayPlaceId) {
      merchantByPlaceId.set(m.citizenPayPlaceId, { id: m.id, name: m.name });
    }
    if (m.citizenPayPlaceAccount) {
      merchantByAccount.set(m.citizenPayPlaceAccount, {
        id: m.id,
        name: m.name,
      });
    }
  }

  if (cpPlacesResult) {
    const seenAccounts = new Set<string>();
    for (const place of cpPlacesResult) {
      if (!place.account) continue;
      const local = merchantByPlaceId.get(place.id);
      const displayName = local?.name ?? place.name;
      // Filter to name match — both the local name and the CP name count,
      // so renaming locally doesn't make the place unfindable.
      const matches =
        displayName.toLowerCase().includes(termLower) ||
        place.name.toLowerCase().includes(termLower);
      if (!matches) continue;
      // Prefer the local Merchant id when available so the hit refers to
      // the row admin actions know about; fall back to CP's place id.
      const id = local?.id ?? place.id;
      const sublabel = displayName !== place.name ? place.name : null;
      hits.push({
        kind: "place",
        id,
        account: place.account,
        label: displayName,
        sublabel,
      });
      seenAccounts.add(place.account);
      if (hits.length >= LIMIT * 3) break;
    }
    // CP succeeded — local-only rows (place exists in Merchant but not
    // CP) are excluded; they have no addressable account anyway.
  } else {
    // CP unreachable — fall back to local Merchant rows that have an
    // account cached. Better than blanking on transient CP errors.
    const filtered = localMerchants
      .filter(
        (m) =>
          m.citizenPayPlaceAccount &&
          m.name.toLowerCase().includes(termLower),
      )
      .slice(0, LIMIT);
    for (const m of filtered) {
      if (!m.citizenPayPlaceAccount) continue;
      hits.push({
        kind: "place",
        id: m.id,
        account: m.citizenPayPlaceAccount,
        label: m.name,
        sublabel: null,
      });
    }
  }

  return hits.slice(0, LIMIT * 2);
}

async function fetchCpPlaces(fund: {
  id: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
}) {
  // CP places are the source of truth for accounts. Failing soft so a CP
  // outage doesn't blank the picker — the caller falls back to local
  // Merchant rows.
  try {
    const client = getCitizenPayClient(fund);
    const { places } = await client.listPlaces();
    return places;
  } catch (e) {
    console.warn("[token-search] listPlaces failed", e);
    return null;
  }
}
