// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  getCitizenPayClient,
  type FundCredentials,
} from "@/services/citizenpay/client";
import type { CitizenPayProfile } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

// 3-tier resolver: on-chain address → human label. Tiers:
//   1) Local Card.account  (joins Member when attached — UI shows holder)
//   2) Local Merchant.citizenPayPlaceAccount  (UI shows place name)
//   3) AddressProfileCache, refreshed from CP's batch profiles endpoint
//
// Anything not matched by any tier is returned in `unknown`. CP can be
// asked to label external wallets that have a CP profile but no presence
// in this fund — typical case: a member of another fund who received a
// transfer from one of our cards.
//
// All addresses are lowercased on input — Card.account /
// Merchant.citizenPayPlaceAccount writes are lowercased at the source so
// the IN-lookups hit. CP's batch endpoint normalises on its side.

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const NEGATIVE_TTL_MS = 60 * 60 * 1000; // 1h

export type ResolvedCard = {
  account: string;
  cardId: string;
  serialNumber: string;
  // Display name with the holderName → memberName → serialNumber fallback
  // already applied, so callers can render `card.name` directly without
  // re-implementing the chain.
  name: string;
};

export type ResolvedPlace = {
  account: string;
  merchantId: string;
  name: string;
};

export type ResolveResult = {
  cards: ResolvedCard[];
  places: ResolvedPlace[];
  profiles: CitizenPayProfile[];
  // Addresses that resolved to nothing (CP confirmed no profile, or CP was
  // unreachable and no stale entry was available).
  unknown: string[];
};

const HEX_ADDR_RE = /^0x[0-9a-f]{40}$/;

function normalize(addresses: string[]): string[] {
  const out = new Set<string>();
  for (const raw of addresses) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (!HEX_ADDR_RE.test(lower)) continue;
    out.add(lower);
  }
  return Array.from(out);
}

/**
 * Resolve a batch of on-chain addresses to local-or-CP labels.
 *
 * Designed for a server component to call once at the top of a render —
 * pass every address that needs labelling, then thread the result down
 * into the row renderers. Repeated calls within a render are wasteful,
 * but harmless; the persisted cache absorbs the CP cost.
 */
export async function resolveAddresses(
  fund: FundCredentials,
  addresses: string[],
): Promise<ResolveResult> {
  const wanted = normalize(addresses);
  if (wanted.length === 0) {
    return { cards: [], places: [], profiles: [], unknown: [] };
  }

  const [cardRows, merchantRows] = await Promise.all([
    prisma.card.findMany({
      where: { fundId: fund.id, account: { in: wanted } },
      select: {
        id: true,
        account: true,
        serialNumber: true,
        holderName: true,
        member: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.merchant.findMany({
      where: { fundId: fund.id, citizenPayPlaceAccount: { in: wanted } },
      select: { id: true, name: true, citizenPayPlaceAccount: true },
    }),
  ]);

  const cards: ResolvedCard[] = [];
  const cardHits = new Set<string>();
  for (const c of cardRows) {
    if (!c.account) continue;
    const holder = c.holderName?.trim() || "";
    const memberName = c.member
      ? `${c.member.firstName} ${c.member.lastName}`.trim()
      : "";
    cards.push({
      account: c.account,
      cardId: c.id,
      serialNumber: c.serialNumber,
      // Fallback chain — every card has a serial, so `name` is always a
      // non-empty string.
      name: holder || memberName || c.serialNumber,
    });
    cardHits.add(c.account);
  }

  const places: ResolvedPlace[] = [];
  const placeHits = new Set<string>();
  for (const m of merchantRows) {
    if (!m.citizenPayPlaceAccount) continue;
    // A card and a place colliding on the same address would be a CP bug,
    // but if it happens we prefer the card (member-level label is more
    // specific). Skip the place row in that case.
    if (cardHits.has(m.citizenPayPlaceAccount)) continue;
    places.push({
      account: m.citizenPayPlaceAccount,
      merchantId: m.id,
      name: m.name,
    });
    placeHits.add(m.citizenPayPlaceAccount);
  }

  const localHits = new Set<string>([...cardHits, ...placeHits]);
  const externalAddresses = wanted.filter((a) => !localHits.has(a));
  if (externalAddresses.length === 0) {
    return { cards, places, profiles: [], unknown: [] };
  }

  const now = Date.now();
  const cacheRows = await prisma.addressProfileCache.findMany({
    where: { fundId: fund.id, address: { in: externalAddresses } },
  });
  const cacheByAddress = new Map(cacheRows.map((r) => [r.address, r]));

  const profiles: CitizenPayProfile[] = [];
  const unknown: string[] = [];
  const toFetch: string[] = [];

  for (const address of externalAddresses) {
    const row = cacheByAddress.get(address);
    if (!row) {
      toFetch.push(address);
      continue;
    }
    const age = now - row.fetchedAt.getTime();
    const ttl = row.notFound ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
    if (age > ttl) {
      toFetch.push(address);
      continue;
    }
    if (row.notFound) {
      unknown.push(address);
    } else {
      profiles.push(rowToProfile(row));
    }
  }

  if (toFetch.length === 0) {
    return { cards, places, profiles, unknown };
  }

  let fetched: Array<CitizenPayProfile | null>;
  try {
    const client = getCitizenPayClient(fund);
    fetched = await client.getProfiles(toFetch);
  } catch (e) {
    // CP unreachable — fall back to whatever stale cache we have for these
    // addresses (better than nothing), and mark the rest as unknown for
    // this render. Don't write to the cache.
    console.error("[profile.resolve] CP batch profiles failed", e);
    for (const address of toFetch) {
      const stale = cacheByAddress.get(address);
      if (stale && !stale.notFound) {
        profiles.push(rowToProfile(stale));
      } else if (stale?.notFound) {
        unknown.push(address);
      } else {
        unknown.push(address);
      }
    }
    return { cards, places, profiles, unknown };
  }

  // Persist hits + misses. Use a transaction's worth of upserts so a
  // single render fully populates the cache.
  await Promise.all(
    toFetch.map((address, i) => {
      const profile = fetched[i];
      if (profile) {
        profiles.push({ ...profile, account: address });
        return prisma.addressProfileCache.upsert({
          where: { fundId_address: { fundId: fund.id, address } },
          create: {
            fundId: fund.id,
            address,
            name: profile.name,
            username: profile.username,
            description: profile.description,
            image: profile.image,
            imageMedium: profile.imageMedium,
            imageSmall: profile.imageSmall,
            parent: profile.parent,
            notFound: false,
          },
          update: {
            name: profile.name,
            username: profile.username,
            description: profile.description,
            image: profile.image,
            imageMedium: profile.imageMedium,
            imageSmall: profile.imageSmall,
            parent: profile.parent,
            notFound: false,
            fetchedAt: new Date(),
          },
        });
      }
      unknown.push(address);
      return prisma.addressProfileCache.upsert({
        where: { fundId_address: { fundId: fund.id, address } },
        create: { fundId: fund.id, address, notFound: true },
        update: {
          name: null,
          username: null,
          description: null,
          image: null,
          imageMedium: null,
          imageSmall: null,
          parent: null,
          notFound: true,
          fetchedAt: new Date(),
        },
      });
    }),
  );

  return { cards, places, profiles, unknown };
}

function rowToProfile(row: {
  address: string;
  name: string | null;
  username: string | null;
  description: string | null;
  image: string | null;
  imageMedium: string | null;
  imageSmall: string | null;
  parent: string | null;
}): CitizenPayProfile {
  return {
    account: row.address,
    name: row.name ?? "",
    username: row.username ?? "",
    description: row.description ?? "",
    image: row.image,
    imageMedium: row.imageMedium,
    imageSmall: row.imageSmall,
    parent: row.parent,
  };
}
