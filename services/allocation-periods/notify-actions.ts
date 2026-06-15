// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";
import { sendAllocationConfirmation } from "@/services/email/transactional";

// Manual allocation-confirmation notifications, driven from the period detail
// page. Manual allocation runs settle their mints directly and skip the
// operation-status cron — so the cron never emails the member. These actions
// let an admin send (or retry) that email by hand and surface whether a given
// allocation has already been notified.
//
// Idempotency key is identical to the cron's
// ("ALLOCATION_CONFIRMATION:operation:<opId>") so the two paths can never
// double-send: whichever runs first creates the Email row; the other sees it.
//
// Unlike the cron, a manual send is an explicit admin action and therefore
// IGNORES the fund-wide confirmationEmailsPausedAt pause (which only gates the
// automatic sends).

type SingleStatus = "sent" | "alreadySent" | "failed";

export type NotifyAllocationResult =
  | { ok: true; status: SingleStatus }
  | { error: string };

const OP_SELECT = {
  id: true,
  type: true,
  status: true,
  amount: true,
  memberId: true,
  account: true,
  member: { select: { email: true, firstName: true, lastName: true } },
  fund: {
    select: {
      id: true,
      name: true,
      primaryColor: true,
      logoUrl: true,
      senderEmail: true,
    },
  },
} satisfies Prisma.TokenOperationSelect;

type OpForNotify = Prisma.TokenOperationGetPayload<{ select: typeof OP_SELECT }>;

export async function notifyAllocationAction(input: {
  tokenOperationId: string;
}): Promise<NotifyAllocationResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const op = await prisma.tokenOperation.findFirst({
    where: { id: input.tokenOperationId, fundId: fund.id },
    select: OP_SELECT,
  });

  if (!op || op.type !== "MINT" || op.status !== "CONFIRMED") {
    return {
      error: t(
        "fund.allocations.periodDetail.notify.errors.notNotifiable" as never,
      ),
    };
  }
  if (!op.memberId || !op.member?.email) {
    return {
      error: t("fund.allocations.periodDetail.notify.errors.noEmail" as never),
    };
  }

  const status = await sendOne(op);
  revalidatePath("/allocations");
  if (status === "failed") {
    return {
      error: t(
        "fund.allocations.periodDetail.notify.errors.sendFailed" as never,
      ),
    };
  }
  return { ok: true, status };
}

export type NotifyPeriodResult =
  | { ok: true; sent: number; skipped: number; failed: number }
  | { error: string };

export async function notifyPeriodAllocationsAction(input: {
  periodId: string;
}): Promise<NotifyPeriodResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const period = await prisma.allocationPeriod.findFirst({
    where: { id: input.periodId, fundId: fund.id },
    select: { id: true },
  });
  if (!period) {
    return { error: t("periods.errors.notFound" as never) };
  }

  const ops = await prisma.tokenOperation.findMany({
    where: {
      fundId: fund.id,
      allocationPeriodId: period.id,
      type: "MINT",
      status: "CONFIRMED",
      memberId: { not: null },
    },
    select: OP_SELECT,
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const op of ops) {
    const status = await sendOne(op);
    if (status === "sent") sent++;
    else if (status === "alreadySent") skipped++;
    else failed++;
  }

  revalidatePath(`/allocations/periods/${period.id}`);
  revalidatePath("/allocations");
  return { ok: true, sent, skipped, failed };
}

// Queue + send one allocation confirmation, reusing the cron's idempotency
// key. Returns "alreadySent" when a prior SENT row exists, "sent" on success,
// "failed" otherwise. A previously FAILED/QUEUED row is reused and retried.
async function sendOne(op: OpForNotify): Promise<SingleStatus> {
  if (!op.memberId || !op.member?.email) return "failed";
  const idempotencyKey = `ALLOCATION_CONFIRMATION:operation:${op.id}`;
  const branding = {
    name: op.fund.name,
    primaryColor: op.fund.primaryColor,
    logoUrl: op.fund.logoUrl,
    senderEmail: op.fund.senderEmail,
  };

  let emailId: string;
  try {
    const row = await prisma.email.create({
      data: {
        fundId: op.fund.id,
        type: "ALLOCATION_CONFIRMATION",
        toEmail: op.member.email,
        memberId: op.memberId,
        tokenOperationId: op.id,
        idempotencyKey,
        subject: "Allocation",
      },
      select: { id: true },
    });
    emailId = row.id;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") {
      console.error("[notify] failed to queue allocation email", op.id, e);
      return "failed";
    }
    // Row already exists for this op. Sent → nothing to do; otherwise reuse
    // the row and retry the send.
    const existing = await prisma.email.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });
    if (!existing) return "failed";
    if (existing.status === "SENT") return "alreadySent";
    await prisma.email.update({
      where: { id: existing.id },
      data: { status: "QUEUED", errorMessage: null, failedAt: null },
    });
    emailId = existing.id;
  }

  await sendAllocationConfirmation({
    emailId,
    fundId: op.fund.id,
    toEmail: op.member.email,
    firstName: op.member.firstName,
    lastName: op.member.lastName,
    account: op.account,
    fund: branding,
    amount: op.amount.toString(),
  });

  // sendAllocationConfirmation swallows errors and marks the row FAILED — read
  // back the outcome so the admin gets accurate feedback.
  const after = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true },
  });
  return after?.status === "SENT" ? "sent" : "failed";
}
