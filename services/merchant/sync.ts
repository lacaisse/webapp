// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Mirror of services/card/sync.ts but adapted to the merchant flow:
//   - We never PUSH places to CP — merchants self-onboard on CitizenPay's
//     side. Local-only Merchant rows just sit unlinked until the merchant
//     connects. So no `push` bucket like cards has.
//   - We IMPORT (link CP places to local merchants) and UNLINK (clear stale
//     placeIds when CP no longer reports a place).
//   - Profile data (name, description, logo) is pulled from CP's
//     /v2/treasury/profiles/{account} endpoint and cached on Merchant on
//     every link/refresh — CP is canonical post-connection.
//   - There is no per-place disconnect on CP. The treasury can only
//     disconnect at the BUSINESS level (which tears down every place under
//     it). See `disconnectMerchantBusiness` below.
//
// Lives outside any `"use server"` file so non-action exports (types,
// computeMerchantSyncPlan) aren't silently rewritten into server-reference
// proxies.

export type MerchantSyncPlan = {
  // CP places that resolve to an unconnected local Merchant by an exact
  // (trimmed, case-insensitive) name match. On confirm we LINK these
  // rather than CREATE, keeping the signup-form merchant intact instead
  // of producing a duplicate row.
  //
  // Matching rules:
  //   - Target merchant must be ACTIVE and have no citizenPayPlaceId yet.
  //   - One CP place claims at most one local merchant; if multiple CP
  //     places share a name, the first wins and the rest fall through to
  //     `unlinkedPlaces` (will be created).
  //   - Local merchants are unique by name per fund (@@unique on the
  //     model), so there's no ambiguity on the local side.
  autoLinks: Array<{
    placeId: string;
    placeName: string;
    merchantId: string;
    merchantName: string;
  }>;
  // CP places with no local match — will be CREATED as new Merchant rows
  // from the CP profile on confirm.
  unlinkedPlaces: Array<{
    placeId: string;
    businessId: string | null;
    name: string;
    account: string | null;
    balanceCents: number | null;
  }>;
  // Local Merchants whose placeId is no longer reported by CP. Either CP
  // disconnected the business or the place was removed. We clear the CP
  // linkage on confirm; the Merchant row stays for the directory.
  stalePlaces: Array<{
    merchantId: string;
    merchantName: string;
    placeId: string;
  }>;
  // Healthy links. Surfaced read-only so the admin can see what's already
  // in sync without leaving the dialog.
  connected: Array<{
    merchantId: string;
    merchantName: string;
    placeId: string;
    businessId: string | null;
  }>;
};

// Minimum fund shape the sync flow needs — matches what
// `requireFundRole("ADMIN")` returns but typed against the CP credential
// columns specifically. Same pattern as services/card/sync.ts::SyncFund.
export type SyncFund = {
  id: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

/**
 * Compute the diff between the local Merchant table and CP's
 * /v2/treasury/places. Throws if CP is unreachable — the caller decides
 * whether to surface or fail soft.
 */
const normaliseName = (s: string) => s.trim().toLowerCase();

export async function computeMerchantSyncPlan(
  fund: SyncFund,
): Promise<MerchantSyncPlan> {
  const client = getCitizenPayClient(fund);
  const [{ places }, merchants] = await Promise.all([
    client.listPlaces(),
    prisma.merchant.findMany({
      where: { fundId: fund.id },
      select: {
        id: true,
        name: true,
        status: true,
        citizenPayPlaceId: true,
        citizenPayBusinessId: true,
      },
    }),
  ]);

  const localByPlaceId = new Map(
    merchants
      .filter((m): m is typeof m & { citizenPayPlaceId: string } =>
        m.citizenPayPlaceId !== null,
      )
      .map((m) => [m.citizenPayPlaceId, m]),
  );
  const remoteByPlaceId = new Map(places.map((p) => [p.id, p]));

  // Index of unconnected ACTIVE merchants by normalised name — eligible
  // auto-link targets. PENDING merchants need approval first; INACTIVE
  // and REJECTED are intentionally excluded.
  const eligibleByName = new Map<string, { id: string; name: string }>();
  for (const m of merchants) {
    if (m.citizenPayPlaceId !== null) continue;
    if (m.status !== "ACTIVE") continue;
    eligibleByName.set(normaliseName(m.name), { id: m.id, name: m.name });
  }

  const plan: MerchantSyncPlan = {
    autoLinks: [],
    unlinkedPlaces: [],
    stalePlaces: [],
    connected: [],
  };

  // Each local merchant can only be claimed once per run — if two CP
  // places share a name, the first wins and the rest get created.
  const claimedMerchantIds = new Set<string>();

  for (const p of places) {
    if (localByPlaceId.has(p.id)) continue;
    const match = eligibleByName.get(normaliseName(p.name));
    if (match && !claimedMerchantIds.has(match.id)) {
      plan.autoLinks.push({
        placeId: p.id,
        placeName: p.name,
        merchantId: match.id,
        merchantName: match.name,
      });
      claimedMerchantIds.add(match.id);
    } else {
      plan.unlinkedPlaces.push({
        placeId: p.id,
        businessId: p.businessId,
        name: p.name,
        account: p.account,
        balanceCents: p.balanceCents,
      });
    }
  }

  for (const m of merchants) {
    if (m.citizenPayPlaceId === null) continue;
    if (!remoteByPlaceId.has(m.citizenPayPlaceId)) {
      plan.stalePlaces.push({
        merchantId: m.id,
        merchantName: m.name,
        placeId: m.citizenPayPlaceId,
      });
    } else {
      plan.connected.push({
        merchantId: m.id,
        merchantName: m.name,
        placeId: m.citizenPayPlaceId,
        businessId: m.citizenPayBusinessId,
      });
    }
  }

  return plan;
}

// CP profile fields we cache locally. Only writes non-empty values so
// admin-entered data (from the signup form, before CP took over) isn't
// blanked out by a CP profile that happens to omit the field.
function profilePatch(profile: {
  name: string;
  description: string;
  image: string | null;
} | null): { name?: string; description?: string; logoUrl?: string } {
  if (!profile) return {};
  const patch: { name?: string; description?: string; logoUrl?: string } = {};
  if (profile.name && profile.name.trim().length > 0) patch.name = profile.name;
  if (profile.description && profile.description.trim().length > 0) {
    patch.description = profile.description;
  }
  if (profile.image) patch.logoUrl = profile.image;
  return patch;
}

// CP-reported postal address + geo. Same write-only-non-empty rule as
// profilePatch — a place can come back with partial location data and
// we shouldn't blank out fields the signup form filled in.
type LocationPatch = {
  address?: string;
  city?: string;
  country?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
};

function locationPatch(place: {
  address: string | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
}): LocationPatch {
  const patch: LocationPatch = {};
  if (place.address && place.address.trim().length > 0) {
    patch.address = place.address;
  }
  if (place.city && place.city.trim().length > 0) patch.city = place.city;
  if (place.country && place.country.trim().length > 0) {
    patch.country = place.country;
  }
  if (place.postalCode && place.postalCode.trim().length > 0) {
    patch.postalCode = place.postalCode;
  }
  if (place.latitude !== null) patch.latitude = place.latitude;
  if (place.longitude !== null) patch.longitude = place.longitude;
  return patch;
}

/**
 * Link a CP place to an existing local Merchant. Writes placeId +
 * businessId + activatedAt and refreshes the cached profile fields
 * (name / description / logoUrl) from CP's profile endpoint when the
 * place has an on-chain account.
 *
 * Caller must have validated fund-admin scope already.
 */
export async function linkPlaceToMerchant(
  fund: SyncFund,
  args: { merchantId: string; placeId: string },
): Promise<{ ok: true }> {
  const client = getCitizenPayClient(fund);
  // Re-fetch places: avoids relying on a stale preview plan (admin could
  // have left the dialog open while CP state changed) and the unique
  // constraint @@unique([fundId, citizenPayPlaceId]) protects against
  // races at the DB level.
  const { places } = await client.listPlaces();
  const place = places.find((p) => p.id === args.placeId);
  if (!place) {
    throw new Error(
      `[merchant-sync] place ${args.placeId} is no longer present on CP`,
    );
  }

  const profile = place.account ? await client.getProfile(place.account) : null;

  await prisma.merchant.update({
    where: { id: args.merchantId, fundId: fund.id },
    data: {
      citizenPayPlaceId: place.id,
      citizenPayBusinessId: place.businessId,
      citizenPayPlaceAccount: place.account,
      citizenPayActivatedAt: new Date(),
      citizenPayLastSyncedAt: new Date(),
      ...profilePatch(profile),
      ...locationPatch(place),
    },
  });
  return { ok: true };
}

/**
 * Create a brand-new local Merchant from a CP place. Used when CP shows
 * a place we have no local row for at all (e.g. the merchant skipped our
 * signup form and went straight to CP). Status defaults to ACTIVE —
 * admin can deactivate later if it shouldn't be in the directory.
 */
export async function importMerchantFromPlace(
  fund: SyncFund,
  args: { placeId: string },
): Promise<{ merchantId: string }> {
  const client = getCitizenPayClient(fund);
  const { places } = await client.listPlaces();
  const place = places.find((p) => p.id === args.placeId);
  if (!place) {
    throw new Error(
      `[merchant-sync] place ${args.placeId} is no longer present on CP`,
    );
  }

  const profile = place.account ? await client.getProfile(place.account) : null;
  const patch = profilePatch(profile);

  const merchant = await prisma.merchant.create({
    data: {
      fundId: fund.id,
      // Fall back to the place's CP name when there's no profile — every
      // place has a name on the wire.
      name: patch.name ?? place.name,
      description: patch.description,
      logoUrl: patch.logoUrl,
      status: "ACTIVE",
      // No signup form was filled, so emailVerifiedAt stays null. Admin
      // can verify out of band.
      citizenPayPlaceId: place.id,
      citizenPayBusinessId: place.businessId,
      citizenPayPlaceAccount: place.account,
      citizenPayActivatedAt: new Date(),
      citizenPayLastSyncedAt: new Date(),
      ...locationPatch(place),
    },
    select: { id: true },
  });
  return { merchantId: merchant.id };
}

/**
 * Clear stale CP linkage on a local Merchant whose place is no longer
 * reported by CP. The Merchant row stays — its directory listing now
 * shows as not-connected.
 */
export async function unlinkStalePlace(
  fund: SyncFund,
  args: { merchantId: string },
): Promise<{ ok: true }> {
  await prisma.merchant.update({
    where: { id: args.merchantId, fundId: fund.id },
    data: {
      citizenPayPlaceId: null,
      citizenPayBusinessId: null,
      citizenPayPlaceAccount: null,
      citizenPayActivatedAt: null,
      citizenPayLastSyncedAt: new Date(),
    },
  });
  return { ok: true };
}

/**
 * Look up every local Merchant in this fund that points at the given
 * CP business. Used by the disconnect confirmation modal — admin
 * needs to see which sibling merchants will also be affected before
 * confirming.
 */
export async function listMerchantsForBusiness(
  fund: SyncFund,
  businessId: string,
): Promise<Array<{ id: string; name: string; citizenPayPlaceId: string | null }>> {
  return prisma.merchant.findMany({
    where: { fundId: fund.id, citizenPayBusinessId: businessId },
    select: { id: true, name: true, citizenPayPlaceId: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Disconnect a CP business from the treasury. Two phases:
 *   1. Snapshot the affected local merchants (for revalidation + audit).
 *   2. Call CP — this removes the token from every place under the
 *      business on CP's side.
 *   3. Clear the CP linkage on every affected Merchant row.
 *
 * Idempotent — `disconnectBusiness` swallows 404s, and the updateMany
 * is a no-op if the rows were already cleared.
 */
export async function disconnectMerchantBusiness(
  fund: SyncFund,
  args: { businessId: string },
): Promise<{ affectedMerchantIds: string[] }> {
  const affected = await prisma.merchant.findMany({
    where: { fundId: fund.id, citizenPayBusinessId: args.businessId },
    select: { id: true },
  });

  const client = getCitizenPayClient(fund);
  await client.disconnectBusiness(args.businessId);

  if (affected.length > 0) {
    await prisma.merchant.updateMany({
      where: { fundId: fund.id, citizenPayBusinessId: args.businessId },
      data: {
        citizenPayPlaceId: null,
        citizenPayBusinessId: null,
        citizenPayPlaceAccount: null,
        citizenPayActivatedAt: null,
        citizenPayLastSyncedAt: new Date(),
      },
    });
  }

  return { affectedMerchantIds: affected.map((m) => m.id) };
}

/**
 * Refresh the cached profile fields for a single connected Merchant.
 * Useful as a per-row "resync" action and called internally by the
 * link flow. No-ops cleanly if the place no longer has an on-chain
 * account or CP returns no profile.
 */
export async function refreshMerchantProfile(
  fund: SyncFund,
  args: { merchantId: string },
): Promise<{ ok: true }> {
  const merchant = await prisma.merchant.findFirst({
    where: { id: args.merchantId, fundId: fund.id },
    select: { citizenPayPlaceId: true },
  });
  if (!merchant?.citizenPayPlaceId) return { ok: true };

  const client = getCitizenPayClient(fund);
  const { places } = await client.listPlaces();
  const place = places.find((p) => p.id === merchant.citizenPayPlaceId);
  if (!place) {
    await prisma.merchant.update({
      where: { id: args.merchantId, fundId: fund.id },
      data: { citizenPayLastSyncedAt: new Date() },
    });
    return { ok: true };
  }
  if (!place.account) {
    // Place known but no on-chain account yet. Refresh businessId,
    // location, and sync timestamp — but don't clear a previously-
    // cached account (CP transient nulls would otherwise blow away a
    // working address).
    await prisma.merchant.update({
      where: { id: args.merchantId, fundId: fund.id },
      data: {
        citizenPayBusinessId: place.businessId,
        citizenPayLastSyncedAt: new Date(),
        ...locationPatch(place),
      },
    });
    return { ok: true };
  }

  const profile = await client.getProfile(place.account);
  await prisma.merchant.update({
    where: { id: args.merchantId, fundId: fund.id },
    data: {
      citizenPayBusinessId: place.businessId,
      citizenPayPlaceAccount: place.account,
      citizenPayLastSyncedAt: new Date(),
      ...profilePatch(profile),
      ...locationPatch(place),
    },
  });
  return { ok: true };
}
