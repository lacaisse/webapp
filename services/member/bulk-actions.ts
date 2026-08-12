// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import type { MemberStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { isSupportedLocale } from "@/services/i18n/config";

import { isMemberDeletable } from "./eligibility";
import { MEMBER_STATUSES, MEMBER_STATUS_TRANSITIONS } from "./status-config";

// Which member property a bulk edit targets. One property per operation so the
// result count stays honest and status-transition rules can be applied cleanly.
// Mirrors the single-member actions (assignTierAction / changeMemberStatusAction)
// but fans out over a selection with a single updateMany.
export type BulkMemberUpdate =
  | { field: "locale"; value: string }
  | { field: "status"; value: MemberStatus }
  | { field: "tier"; value: string | null };

export type BulkUpdateMembersResult =
  | { ok: true; updated: number; skipped: number }
  | { error: string };

// Guard against a pathological payload; a fund's whole member list is well
// under this, but we never want an unbounded `IN (...)`.
const MAX_BULK = 5000;

// Apply one property change to a set of members in the current fund. Every
// write is fund-scoped, so a stale/spoofed id from another fund is silently
// dropped. For status we honour the same per-member transition map the single
// dialog uses: members whose current status can't reach the target are skipped
// (reported back), not forced.
export async function bulkUpdateMembersAction(input: {
  memberIds: string[];
  update: BulkMemberUpdate;
}): Promise<BulkUpdateMembersResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const memberIds = Array.from(new Set(input.memberIds ?? [])).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (memberIds.length === 0) {
    return { error: t("members.admin.bulk.errors.noSelection" as never) };
  }
  if (memberIds.length > MAX_BULK) {
    return { error: t("members.admin.bulk.errors.tooMany" as never) };
  }

  // Scope to this fund up front — this is the trust boundary for every write
  // below (we only ever update ids that came back from here).
  const members = await prisma.member.findMany({
    where: { id: { in: memberIds }, fundId: fund.id },
    select: { id: true, status: true },
  });
  if (members.length === 0) {
    return { error: t("members.admin.errors.notFound" as never) };
  }
  const scopedIds = members.map((m) => m.id);

  const { update } = input;

  if (update.field === "locale") {
    if (!isSupportedLocale(update.value)) {
      return { error: t("members.admin.bulk.errors.invalidValue" as never) };
    }
    const res = await prisma.member.updateMany({
      where: { id: { in: scopedIds }, fundId: fund.id },
      data: { locale: update.value },
    });
    revalidatePath("/members");
    return { ok: true, updated: res.count, skipped: 0 };
  }

  if (update.field === "tier") {
    if (update.value !== null) {
      const tier = await prisma.allocationTier.findFirst({
        where: { id: update.value, fundId: fund.id, archivedAt: null },
        select: { id: true },
      });
      if (!tier) {
        return { error: t("members.admin.errors.tierNotFound" as never) };
      }
    }
    const res = await prisma.member.updateMany({
      where: { id: { in: scopedIds }, fundId: fund.id },
      data: { tierId: update.value },
    });
    revalidatePath("/members");
    return { ok: true, updated: res.count, skipped: 0 };
  }

  // Status: partition by transition validity (mirrors changeMemberStatusAction).
  // Already-at-target members are a no-op (neither updated nor skipped); members
  // whose current status can't legally reach the target are skipped.
  const target = update.value;
  if (!MEMBER_STATUSES.includes(target)) {
    return { error: t("members.admin.bulk.errors.invalidValue" as never) };
  }

  const eligible: string[] = [];
  let skipped = 0;
  for (const m of members) {
    if (m.status === target) continue;
    if (MEMBER_STATUS_TRANSITIONS[m.status].includes(target)) {
      eligible.push(m.id);
    } else {
      skipped++;
    }
  }

  let updated = 0;
  if (eligible.length > 0) {
    const res = await prisma.member.updateMany({
      where: { id: { in: eligible }, fundId: fund.id },
      data: {
        status: target,
        // Entering STOPPED stamps a leave date; any other target clears it
        // (only STOPPED members carry a leftAt, and STOPPED → ACTIVE is the
        // only way out).
        leftAt: target === "STOPPED" ? new Date() : null,
      },
    });
    updated = res.count;
  }

  revalidatePath("/members");
  return { ok: true, updated, skipped };
}

export type BulkDeleteMembersResult =
  | { ok: true; deleted: number; skipped: number }
  | { error: string };

// Bulk counterpart to deleteMemberAction (issue #35). Same eligibility gate —
// no linked card, no transaction history — applied per member; anyone who
// doesn't qualify is skipped and reported back rather than blocking the whole
// batch or being silently dropped.
export async function bulkDeleteMembersAction(input: {
  memberIds: string[];
}): Promise<BulkDeleteMembersResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const memberIds = Array.from(new Set(input.memberIds ?? [])).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (memberIds.length === 0) {
    return { error: t("members.admin.bulk.errors.noSelection" as never) };
  }
  if (memberIds.length > MAX_BULK) {
    return { error: t("members.admin.bulk.errors.tooMany" as never) };
  }

  const members = await prisma.member.findMany({
    where: { id: { in: memberIds }, fundId: fund.id },
    select: {
      id: true,
      _count: {
        select: { cards: true, bankTransactions: true, tokenOperations: true },
      },
    },
  });
  if (members.length === 0) {
    return { error: t("members.admin.errors.notFound" as never) };
  }

  const deletableIds = members
    .filter((m) => isMemberDeletable(m._count))
    .map((m) => m.id);
  const skipped = members.length - deletableIds.length;

  let deleted = 0;
  if (deletableIds.length > 0) {
    const res = await prisma.member.deleteMany({
      where: { id: { in: deletableIds }, fundId: fund.id },
    });
    deleted = res.count;
  }

  revalidatePath("/members");
  return { ok: true, deleted, skipped };
}
