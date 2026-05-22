// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import {
  sendMerchantApproved,
  sendMerchantRejected,
} from "@/services/email/transactional";
import { getFundUrl } from "@/services/fund/server";
import {
  computeMerchantSyncPlan,
  disconnectMerchantBusiness,
  importMerchantFromPlace,
  linkPlaceToMerchant,
  refreshMerchantProfile,
  unlinkStalePlace,
} from "./sync";

export type ReviewMerchantResult = { ok: true } | { error: string };

export async function approveMerchantAction(input: {
  merchantId: string;
  note?: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { user, fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, email: true, name: true, status: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.status === "ACTIVE") {
    return { error: t("merchants.admin.errors.alreadyApproved" as never) };
  }

  // Per-fund subject + idempotency. Approval can happen after a prior REJECT
  // (REJECTED is reconsiderable), so we key the email by merchant + a
  // monotonic counter would be ideal — but for v1, merchant-id-keyed is fine
  // since the typical case is one approval per merchant lifetime.
  const subject = t("merchants.admin.email.approved.subject" as never, {
    fundName: fund.name,
  } as never);

  const onboardingUrl = process.env.CITIZENPAY_MERCHANT_ONBOARDING_URL || null;

  const emailRow = await prisma.$transaction(async (tx) => {
    await tx.merchant.update({
      where: { id: merchant.id },
      data: {
        status: "ACTIVE",
        reviewedAt: new Date(),
        reviewerId: user.id,
        reviewNote: input.note?.trim() || null,
      },
    });
    return tx.email.create({
      data: {
        fundId: fund.id,
        type: "MERCHANT_APPROVED",
        toEmail: merchant.email!,
        merchantId: merchant.id,
        idempotencyKey: `MERCHANT_APPROVED:merchant:${merchant.id}`,
        subject,
      },
    });
  });

  await sendMerchantApproved({
    emailId: emailRow.id,
    toEmail: merchant.email!,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
    },
    merchantName: merchant.name,
    citizenPayOnboardingUrl: onboardingUrl,
  });

  revalidatePath("/merchants");
  return { ok: true };
}

// =============================================================================
// Archive / restore (status: ACTIVE ↔ INACTIVE)
// =============================================================================
// INACTIVE is the project's archive state — the merchant row stays in
// the DB and the "inactive" tab, but doesn't appear in the active
// directory or in CP-sync targets. Archive is only allowed when the
// merchant isn't connected to a CP business; we don't want to silently
// orphan a live token. Restore flips back to ACTIVE; admin can re-invite
// from there.

export async function archiveMerchantAction(input: {
  merchantId: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, status: true, citizenPayBusinessId: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.citizenPayBusinessId) {
    return {
      error: t("merchants.admin.archive.errors.stillConnected" as never),
    };
  }
  if (merchant.status === "INACTIVE") {
    return {
      error: t("merchants.admin.archive.errors.alreadyArchived" as never),
    };
  }
  if (merchant.status !== "ACTIVE") {
    // PENDING / REJECTED have their own state machine — archive is for
    // ACTIVE rows only.
    return { error: t("merchants.admin.archive.errors.notActive" as never) };
  }

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { status: "INACTIVE" },
  });

  revalidatePath("/merchants");
  return { ok: true };
}

export async function restoreMerchantAction(input: {
  merchantId: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, status: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.status !== "INACTIVE") {
    return { error: t("merchants.admin.archive.errors.notArchived" as never) };
  }

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { status: "ACTIVE" },
  });

  revalidatePath("/merchants");
  return { ok: true };
}

// Permanently delete an archived merchant. Gated on INACTIVE + no CP
// business: an admin must Disconnect → Archive → Delete in order, so
// there's no path that silently strips a live CP connection. Cascade
// behaviour from the schema:
//   - EmailVerification rows cascade-delete (Merchant.emailVerifications)
//   - BankTransaction.merchantId nulls out (history preserved, payouts
//     remain in the ledger but lose the merchant link)
//   - Email.merchantId nulls out (audit trail kept)
export async function deleteMerchantAction(input: {
  merchantId: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, status: true, citizenPayBusinessId: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.status !== "INACTIVE") {
    return { error: t("merchants.admin.delete.errors.notArchived" as never) };
  }
  if (merchant.citizenPayBusinessId) {
    // Belt-and-braces: archive already gates on this, but a delete is
    // permanent, so we re-check on the way out.
    return { error: t("merchants.admin.delete.errors.stillConnected" as never) };
  }

  await prisma.merchant.delete({ where: { id: merchant.id } });

  revalidatePath("/merchants");
  return { ok: true };
}

export async function reconsiderMerchantAction(input: {
  merchantId: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, status: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.status !== "REJECTED") {
    return { error: t("merchants.admin.errors.notRejected" as never) };
  }

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      status: "PENDING",
      reviewedAt: null,
      reviewerId: null,
      reviewNote: null,
    },
  });

  revalidatePath("/merchants");
  return { ok: true };
}

export async function rejectMerchantAction(input: {
  merchantId: string;
  note: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { user, fund } = await requireFundRole("ADMIN");

  const reason = input.note.trim();
  if (!reason) {
    return { error: t("merchants.admin.errors.reasonRequired" as never) };
  }

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, email: true, name: true, status: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.status === "REJECTED") {
    return { error: t("merchants.admin.errors.alreadyRejected" as never) };
  }

  const subject = t("merchants.admin.email.rejected.subject" as never, {
    fundName: fund.name,
  } as never);

  const emailRow = await prisma.$transaction(async (tx) => {
    await tx.merchant.update({
      where: { id: merchant.id },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewerId: user.id,
        reviewNote: reason,
      },
    });
    return tx.email.create({
      data: {
        fundId: fund.id,
        type: "MERCHANT_REJECTED",
        toEmail: merchant.email!,
        merchantId: merchant.id,
        idempotencyKey: `MERCHANT_REJECTED:merchant:${merchant.id}`,
        subject,
      },
    });
  });

  await sendMerchantRejected({
    emailId: emailRow.id,
    toEmail: merchant.email!,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
    },
    merchantName: merchant.name,
    reason,
  });

  revalidatePath("/merchants");
  return { ok: true };
}

// =============================================================================
// CitizenPay sync — driven from the client for progress UX
// =============================================================================
// Mirrors the card sync flow in services/card/admin-actions.ts. The Sync
// dialog on /merchants calls `previewMerchantSyncAction` once to fetch
// the full plan (unlinked CP places + stale local linkages + the list of
// linkable local merchants), then iterates per-item server actions on the
// client so it can render real-time progress and let the admin choose
// link-vs-create per place.

export type MerchantSyncPlanWire = {
  // CP places that exact-name-match an unconnected local Merchant — will
  // be LINKED on confirm, preserving the signup-form row.
  autoLinks: Array<{
    placeId: string;
    placeName: string;
    merchantId: string;
    merchantName: string;
  }>;
  // CP places with no local match — each becomes a NEW local Merchant
  // row on confirm (name/description/logo from the CP profile).
  unlinkedPlaces: Array<{
    placeId: string;
    name: string;
  }>;
  // Local merchants whose placeId is no longer on CP — clear linkage.
  stalePlaces: Array<{
    merchantId: string;
    merchantName: string;
  }>;
  // Count of already-connected, in-sync merchants (display only).
  connectedCount: number;
};

export type MerchantSyncPreviewResult =
  | { ok: true; plan: MerchantSyncPlanWire }
  | { error: string };

export async function previewMerchantSyncAction(): Promise<MerchantSyncPreviewResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  try {
    const plan = await computeMerchantSyncPlan(fund);
    return {
      ok: true,
      plan: {
        autoLinks: plan.autoLinks,
        unlinkedPlaces: plan.unlinkedPlaces.map((p) => ({
          placeId: p.placeId,
          name: p.name,
        })),
        stalePlaces: plan.stalePlaces.map((s) => ({
          merchantId: s.merchantId,
          merchantName: s.merchantName,
        })),
        connectedCount: plan.connected.length,
      },
    };
  } catch (e) {
    console.error("[merchant.sync] preview failed", e);
    return { error: t("merchants.admin.sync.errors.previewFailed" as never) };
  }
}

// =============================================================================
// Invite to connect on Citizen Pay
// =============================================================================
// Email-keyed invite flow (see docs/TREASURY_DASHBOARD_CONNECTIONS.md).
// Admin clicks "Invite to Citizen Pay" on an unconnected merchant; we
// call CP's /v2/treasury/invites with the merchant's email + a callback
// URL on this fund's host. CP emails the recipient, who accepts on the
// CP dashboard and lands back at /api/citizenpay/invite-callback — that
// route writes citizenPayBusinessId.
//
// Re-inviting an already-invited merchant is allowed: CP auto-rejects
// the old token, we just overwrite our local snapshot.

const InviteSchema = z.object({
  merchantId: z.string().min(1),
  email: z.email({ error: "merchants.signup.errors.emailInvalid" }),
});

export type InviteMerchantResult =
  | { ok: true; inviteUrl: string; emailSent: boolean; expiresAt: string }
  | { error: string; field?: "email" };

export async function inviteMerchantAction(input: {
  merchantId: string;
  email: string;
}): Promise<InviteMerchantResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = InviteSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] === "email" ? "email" : undefined,
    };
  }

  const merchant = await prisma.merchant.findFirst({
    where: { id: parsed.data.merchantId, fundId: fund.id },
    select: { id: true, email: true, citizenPayBusinessId: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.citizenPayBusinessId) {
    return {
      error: t("merchants.admin.invite.errors.alreadyConnected" as never),
    };
  }

  const email = parsed.data.email.trim().toLowerCase();
  const redirectUri = `${getFundUrl(fund.domain)}/api/citizenpay/invite-callback`;

  let invite;
  try {
    invite = await getCitizenPayClient(fund).createMerchantInvite({
      email,
      redirectUri,
    });
  } catch (e) {
    console.error("[merchant.invite] CP mint failed", merchant.id, e);
    return { error: t("merchants.admin.invite.errors.mintFailed" as never) };
  }

  // Persist email + token together. Updating the merchant's email at
  // this point is correct: the admin just confirmed it's the right
  // address (they entered it into the modal) and CP has now sent mail
  // to that address.
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      email,
      citizenPayInviteToken: invite.token,
      citizenPayInviteEmail: invite.email,
      citizenPayInviteSentAt: new Date(),
      citizenPayInviteExpiresAt: new Date(invite.expiresAt),
    },
  });

  revalidatePath("/merchants");
  return {
    ok: true,
    inviteUrl: invite.inviteUrl,
    emailSent: invite.emailSent,
    expiresAt: invite.expiresAt,
  };
}

// =============================================================================
// Per-merchant manual link (option A)
// =============================================================================
// Used by the row/detail-page "Link to Citizen Pay place" action on an
// unconnected merchant. Returns the CP places that aren't yet linked to
// any merchant in this fund — small list, no pagination needed.

export type LinkablePlace = {
  placeId: string;
  name: string;
  businessId: string | null;
};

export type ListLinkablePlacesResult =
  | { ok: true; places: LinkablePlace[] }
  | { error: string };

export async function listLinkableCitizenPayPlacesAction(): Promise<ListLinkablePlacesResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  try {
    const plan = await computeMerchantSyncPlan(fund);
    // Auto-link suggestions + truly unlinked — both are valid targets
    // for a manual link from any unconnected merchant. The admin might
    // intentionally want to override an auto-match (e.g. two places with
    // similar names belong to different signup rows).
    const places: LinkablePlace[] = [
      ...plan.autoLinks.map((a) => ({
        placeId: a.placeId,
        name: a.placeName,
        businessId: null,
      })),
      ...plan.unlinkedPlaces.map((p) => ({
        placeId: p.placeId,
        name: p.name,
        businessId: p.businessId,
      })),
    ];
    places.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, places };
  } catch (e) {
    console.error("[merchant.sync] listLinkable failed", e);
    return { error: t("merchants.admin.sync.errors.previewFailed" as never) };
  }
}

export type MerchantSyncItemResult = { ok: true } | { error: string };

export async function linkPlaceToMerchantAction(input: {
  merchantId: string;
  placeId: string;
}): Promise<MerchantSyncItemResult> {
  const { fund } = await requireFundRole("ADMIN");
  try {
    await linkPlaceToMerchant(fund, input);
    return { ok: true };
  } catch (e) {
    console.error("[merchant.sync] link failed", input, e);
    return { error: input.placeId };
  }
}

export async function createMerchantFromPlaceAction(input: {
  placeId: string;
}): Promise<MerchantSyncItemResult> {
  const { fund } = await requireFundRole("ADMIN");
  try {
    await importMerchantFromPlace(fund, input);
    return { ok: true };
  } catch (e) {
    console.error("[merchant.sync] create-from-place failed", input, e);
    return { error: input.placeId };
  }
}

export async function unlinkStaleMerchantAction(input: {
  merchantId: string;
}): Promise<MerchantSyncItemResult> {
  const { fund } = await requireFundRole("ADMIN");
  try {
    await unlinkStalePlace(fund, input);
    return { ok: true };
  } catch (e) {
    console.error("[merchant.sync] unlink failed", input, e);
    return { error: input.merchantId };
  }
}

export async function refreshMerchantProfileAction(input: {
  merchantId: string;
}): Promise<MerchantSyncItemResult> {
  const { fund } = await requireFundRole("ADMIN");
  try {
    await refreshMerchantProfile(fund, input);
    return { ok: true };
  } catch (e) {
    console.error("[merchant.sync] refresh failed", input, e);
    return { error: input.merchantId };
  }
}

/**
 * Called by the sync dialog once the whole run is done — one
 * revalidatePath flush so the /merchants table picks up every change.
 */
export async function revalidateMerchantsAfterSyncAction(): Promise<void> {
  await requireFundRole("ADMIN");
  revalidatePath("/merchants");
}

// =============================================================================
// Disconnect (business-level)
// =============================================================================
// CitizenPay only exposes disconnection at the business level — calling
// it tears down every place under that business. Two server actions:
//   1. previewDisconnectAction → admin opens the confirm modal; we return
//      every sibling Merchant that'll be affected so the modal can list
//      them explicitly.
//   2. disconnectAction → calls CP, clears the local linkage on every
//      affected Merchant row.

// Per-place row shown in the disconnect modal. We list ALL CP places
// under the business — including ones not yet linked to a local
// Merchant — because they all get torn down together and any of them
// holding a balance must be settled (paid out) before we let the
// admin disconnect.
export type AffectedPlace = {
  placeId: string;
  placeName: string;
  balanceCents: number | null;
  localMerchantId: string | null;
  localMerchantName: string | null;
};

export type DisconnectPreviewResult =
  | {
      ok: true;
      businessId: string;
      affectedPlaces: AffectedPlace[];
      // True when every affected place has a zero balance. The modal's
      // Confirm button is disabled when false; the server action below
      // re-checks the same condition before calling CP.
      canDisconnect: boolean;
    }
  | { error: string };

async function resolveDisconnectTargets(
  fund: { id: string; citizenPayApiKeyId: string | null; citizenPayApiKeyEnc: string | null },
  businessId: string,
): Promise<AffectedPlace[]> {
  const client = getCitizenPayClient(fund);
  const [{ places }, localMerchants] = await Promise.all([
    client.listPlaces(),
    prisma.merchant.findMany({
      where: { fundId: fund.id, citizenPayBusinessId: businessId },
      select: { id: true, name: true, citizenPayPlaceId: true },
    }),
  ]);
  const localByPlaceId = new Map(
    localMerchants
      .filter((m): m is typeof m & { citizenPayPlaceId: string } =>
        m.citizenPayPlaceId !== null,
      )
      .map((m) => [m.citizenPayPlaceId, m]),
  );
  return places
    .filter((p) => p.businessId === businessId)
    .map((p) => {
      const local = localByPlaceId.get(p.id) ?? null;
      return {
        placeId: p.id,
        placeName: p.name,
        balanceCents: p.balanceCents,
        localMerchantId: local?.id ?? null,
        localMerchantName: local?.name ?? null,
      };
    })
    .sort((a, b) => a.placeName.localeCompare(b.placeName));
}

function allBalancesSettled(places: AffectedPlace[]): boolean {
  // Treat unknown balances (null) as un-settled — without a number we
  // can't prove there's nothing to pay out. CP returning null on a
  // connected place is rare; admin needs to wait for the next sync.
  return places.every(
    (p) => p.balanceCents !== null && p.balanceCents === 0,
  );
}

export async function previewDisconnectMerchantAction(input: {
  merchantId: string;
}): Promise<DisconnectPreviewResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, citizenPayBusinessId: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (!merchant.citizenPayBusinessId) {
    return {
      error: t("merchants.admin.disconnect.errors.notConnected" as never),
    };
  }

  try {
    const affectedPlaces = await resolveDisconnectTargets(
      fund,
      merchant.citizenPayBusinessId,
    );
    return {
      ok: true,
      businessId: merchant.citizenPayBusinessId,
      affectedPlaces,
      canDisconnect: allBalancesSettled(affectedPlaces),
    };
  } catch (e) {
    console.error("[merchant] disconnect preview failed", input.merchantId, e);
    return { error: t("merchants.admin.disconnect.errors.failed" as never) };
  }
}

export type DisconnectResult = { ok: true } | { error: string };

export async function disconnectMerchantAction(input: {
  merchantId: string;
}): Promise<DisconnectResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, citizenPayBusinessId: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (!merchant.citizenPayBusinessId) {
    return {
      error: t("merchants.admin.disconnect.errors.notConnected" as never),
    };
  }

  try {
    // Re-check balances right before we fire the disconnect — the
    // preview the admin saw might be seconds old and a top-up could
    // have landed since.
    const affectedPlaces = await resolveDisconnectTargets(
      fund,
      merchant.citizenPayBusinessId,
    );
    if (!allBalancesSettled(affectedPlaces)) {
      return {
        error: t(
          "merchants.admin.disconnect.errors.balanceNotZero" as never,
        ),
      };
    }

    await disconnectMerchantBusiness(fund, {
      businessId: merchant.citizenPayBusinessId,
    });
    revalidatePath("/merchants");
    return { ok: true };
  } catch (e) {
    console.error("[merchant] disconnect failed", input.merchantId, e);
    return { error: t("merchants.admin.disconnect.errors.failed" as never) };
  }
}
