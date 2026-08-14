// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { dispatchCardAssignedEmail } from "@/services/card/notify";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import { nextCardNumber } from "@/services/card/numbering";
import { normalizeSerial } from "@/services/card/serial";
import {
  sendMemberActivated,
  sendMemberInvited,
} from "@/services/email/transactional";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";
import { isMemberDeletable } from "./eligibility";
import { BuiltinSignupSchema } from "./schema";
import { generatePaymentReference } from "./payment-reference";

const MAX_REFERENCE_RETRIES = 5;

export type ActivateMemberResult = { ok: true } | { error: string };

// Activation: admin picks an existing unattached card (imported from
// CitizenPay via the sync flow) and links it to the member. We don't
// re-register with CP — the card is already known there. Card.status is
// whatever CP last reported; we leave it alone. The member flips to
// ACTIVE since they're a fully-onboarded recipient regardless of
// terminal state.

export async function activateMemberAction(input: {
  memberId: string;
  cardId: string;
  note?: string;
  // Also send the CARD_ASSIGNED ("your card is on its way") email. Defaults to
  // true; the assign dialog surfaces it as a checkbox. Still gated by the
  // fund-wide member-email pause.
  sendCardEmail?: boolean;
}): Promise<ActivateMemberResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("OPERATOR");

  if (!input.cardId) {
    return { error: t("members.admin.errors.cardRequired" as never) };
  }

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      address: true,
      postalCode: true,
      city: true,
      status: true,
      primaryCardId: true,
    },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };
  if (member.primaryCardId) {
    return { error: t("members.admin.errors.alreadyHasPrimaryCard" as never) };
  }
  // Assigning a primary card is the activation step for a NEW member, and the
  // catch-up step for an ACTIVE member who has none yet (e.g. imported ACTIVE
  // with no matching serial). Other statuses must be moved to active first.
  if (member.status !== "NEW" && member.status !== "ACTIVE") {
    return { error: t("members.admin.errors.notAssignable" as never) };
  }
  // True activation (status flip + welcome email) only when coming from NEW.
  const isActivation = member.status === "NEW";

  // Pick must be a fund-scoped, unattached card. Anything else (foreign
  // fund, already-linked) means the operator's picker is stale.
  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: {
      id: true,
      serialNumber: true,
      number: true,
      account: true,
      memberId: true,
    },
  });
  if (!card) {
    return { error: t("members.admin.errors.cardNotFound" as never) };
  }
  if (card.memberId) {
    return { error: t("members.admin.errors.cardTaken" as never) };
  }

  // Look up an existing PENDING referral where this member is the referee.
  // If we find one (and the sponsor still has a primary card), we'll trigger
  // the bonus mint in the same transaction.
  const referral = await prisma.referral.findUnique({
    where: { refereeId: member.id },
    include: {
      sponsor: {
        select: {
          id: true,
          primaryCard: { select: { id: true, account: true } },
        },
      },
    },
  });
  const canFireReferral =
    referral?.status === "PENDING" &&
    referral.sponsor.primaryCard?.account &&
    fund.referralBonusAmount &&
    fund.referralBonusAmount.toNumber() > 0;

  const welcomeSubject = t(
    "members.admin.email.activated.subject" as never,
    { fundName: fund.name } as never,
  );

  const cp = getCitizenPayClient(fund);
  const holderName = `${member.firstName} ${member.lastName}`.trim();

  const tx = await prisma.$transaction(async (tx) => {
    // 1. Bind the existing card to the member. We don't change `status`
    //    or `account` — those mirror CitizenPay state and were populated
    //    during the import sync.
    await tx.card.update({
      where: { id: card.id },
      data: {
        memberId: member.id,
        holderName,
      },
    });

    // 2. Link as primary + flip member to ACTIVE.
    await tx.member.update({
      where: { id: member.id },
      data: {
        primaryCardId: card.id,
        status: "ACTIVE",
        notes: input.note?.trim() || undefined,
      },
    });

    // 3. Queue + return the welcome (activation) email — only on a real
    // activation (NEW → ACTIVE), and unless member emails are paused (fund
    // settings): skipped, not queued.
    const emailRow = !isActivation || fund.confirmationEmailsPausedAt
      ? null
      : await tx.email.create({
          data: {
            fundId: fund.id,
            type: "MEMBER_ACTIVATED",
            toEmail: member.email,
            memberId: member.id,
            idempotencyKey: `MEMBER_ACTIVATED:member:${member.id}`,
            subject: welcomeSubject,
          },
        });

    // 4. Referral reward (if applicable). Create a PENDING TokenOperation
    // and flip the referral to ACTIVATED. Submission to CP happens after
    // the transaction so HTTP latency doesn't hold DB locks.
    let referralOpId: string | null = null;
    if (canFireReferral && referral) {
      const op = await tx.tokenOperation.create({
        data: {
          fundId: fund.id,
          type: "MINT",
          memberId: referral.sponsor.id,
          account: referral.sponsor.primaryCard!.account!,
          amount: fund.referralBonusAmount!,
          status: "PENDING",
        },
      });
      await tx.referral.update({
        where: { id: referral.id },
        data: {
          status: "ACTIVATED",
          activatedAt: new Date(),
          rewardOperationId: op.id,
        },
      });
      referralOpId = op.id;
    }

    return {
      emailId: emailRow?.id ?? null,
      cardSerial: card.serialNumber,
      referralOpId,
    };
  });

  // Submit the referral mint to CitizenPay outside the transaction. On
  // success we stamp the tx hash; on failure the op stays PENDING and the
  // polling job retries.
  if (tx.referralOpId && referral?.sponsor.primaryCard?.account) {
    try {
      const submitted = await cp.submitMint({
        fundCitizenPayId: fund.citizenPayFundId,
        toAccount: referral.sponsor.primaryCard.account,
        amount: fund.referralBonusAmount!.toString(),
        reference: tx.referralOpId,
      });
      await prisma.tokenOperation.update({
        where: { id: tx.referralOpId },
        data: { txHash: submitted.txHash },
      });
      // Reward mint fired by this admin's activation of the referee. CP's
      // submitMint returns a userOp hash, not the settlement tx hash —
      // resolve it (or queue for the annotation-resolve cron) so the
      // annotation matches the transfer history.
      await resolveOrEnqueueAnnotation({
        fundId: fund.id,
        chainId: fund.tokenChainId,
        userOpHash: submitted.txHash,
        kind: ANNOTATION_TRIGGERS.referralReward,
        trigger: ANNOTATION_TRIGGERS.referralReward,
        triggeredByUserId: user.id,
      });
    } catch (e) {
      console.error("[citizenpay] submitMint failed for referral reward", e);
    }
  }

  // Outside the transaction: dispatch the Resend send (skipped while member
  // emails are paused — no row was queued). Failure is swallowed by the
  // sender so activation never fails because of an email problem.
  if (tx.emailId) {
    await sendMemberActivated({
      emailId: tx.emailId,
      fundId: fund.id,
      toEmail: member.email,
      fund: {
        name: fund.name,
        primaryColor: fund.primaryColor,
        logoUrl: fund.logoUrl,
        senderEmail: fund.senderEmail,
      },
      firstName: member.firstName,
      cardSerial: tx.cardSerial,
      // The bank-transfer reference is the card UID (bank-sync's match key) —
      // the same serial the member's card carries, just above.
      paymentReference: tx.cardSerial,
    });
  }

  // Card-assigned ("your card is on its way") email — opt-in from the assign
  // dialog, default on. Same member-email pause gate as the welcome email; a
  // send failure never fails the activation (dispatch swallows send errors and
  // we swallow the rare DB error).
  const sendCardEmail =
    (input.sendCardEmail ?? true) && !fund.confirmationEmailsPausedAt;
  if (sendCardEmail) {
    try {
      await dispatchCardAssignedEmail({
        fund,
        card: {
          id: card.id,
          serialNumber: card.serialNumber,
          number: card.number,
          memberId: member.id,
          member: {
            email: member.email,
            firstName: member.firstName,
            lastName: member.lastName,
            address: member.address,
            postalCode: member.postalCode,
            city: member.city,
          },
        },
      });
    } catch (e) {
      console.error("[activate] card-assigned email dispatch failed", card.id, e);
    }
  }

  revalidatePath("/members");
  return { ok: true };
}

export type AddCardResult = { ok: true } | { error: string };

// Issue an additional card to an already-ACTIVE member (5.3.2). Used for
// dependants — spouse, children. The new card binds to the same member;
// at CitizenPay it'll be wired to share the primary's wallet so the
// spending limit lives on the primary card, not the new one.
export async function addCardAction(input: {
  memberId: string;
  cardSerial: string;
  holderName?: string;
}): Promise<AddCardResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const cardSerial = normalizeSerial(input.cardSerial);
  if (!cardSerial) {
    return { error: t("members.admin.errors.serialRequired" as never) };
  }

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      status: true,
      primaryCardId: true,
    },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };
  if (member.status !== "ACTIVE") {
    return { error: t("members.admin.errors.notActiveForCard" as never) };
  }
  if (!member.primaryCardId) {
    return { error: t("members.admin.errors.noPrimaryCard" as never) };
  }

  const existing = await prisma.card.findFirst({
    where: { serialNumber: { equals: cardSerial, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) {
    return { error: t("members.admin.errors.serialTaken" as never) };
  }

  const holderName =
    input.holderName?.trim() ||
    `${member.firstName} ${member.lastName}`.trim();

  // Register with CitizenPay first to claim the wallet address. Same
  // fail-soft behaviour as activation — local row is still created if CP
  // is unreachable.
  const cp = getCitizenPayClient(fund);
  let cpAccount: string | null = null;
  try {
    const registered = await cp.registerCard({
      serialNumber: cardSerial,
      fundId: fund.id,
      fundCitizenPayId: fund.citizenPayFundId,
      holderName,
    });
    cpAccount = registered.account;
  } catch (e) {
    console.error("[citizenpay] registerCard failed during addCard", e);
  }

  await prisma.card.create({
    data: {
      fundId: fund.id,
      memberId: member.id,
      serialNumber: cardSerial,
      account: cpAccount,
      number: await nextCardNumber(fund.id),
      holderName,
      status: "INACTIVE", // CP confirms terminal-active separately
      issuedAt: new Date(),
    },
  });

  revalidatePath("/members");
  return { ok: true };
}

export type InviteMemberResult =
  | { ok: true }
  | { error: string; field?: "firstName" | "lastName" | "email" };

// Admin-initiated add: creates a NEW member from a paper-form or
// admin-known recipient and shows up in the "new" tab so the admin can
// activate them when a card is in hand. When `notify` is true we also
// email them a heads-up; when false the member is added silently.
export async function inviteMemberAction(input: {
  firstName: string;
  lastName: string;
  email: string;
  notify?: boolean;
}): Promise<InviteMemberResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const parsed = BuiltinSignupSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as "firstName" | "lastName" | "email" | undefined,
    };
  }

  // Member-email pause (fund settings) overrides the notify checkbox: while
  // paused, NO member-facing email goes out — invitations included.
  const notify = (input.notify ?? true) && !fund.confirmationEmailsPausedAt;

  const inviteSubject = t("members.admin.email.invited.subject" as never, {
    fundName: fund.name,
  } as never);

  for (let attempt = 0; attempt < MAX_REFERENCE_RETRIES; attempt++) {
    const paymentReference = generatePaymentReference();

    let result: { memberId: string; emailId: string | null } | null = null;
    try {
      result = await prisma.$transaction(async (tx) => {
        const m = await tx.member.create({
          data: {
            fundId: fund.id,
            email: parsed.data.email,
            firstName: parsed.data.firstName,
            lastName: parsed.data.lastName,
            status: "NEW",
            paymentReference,
            // Admin vouches for identity — no verification round-trip.
            emailVerifiedAt: new Date(),
          },
        });
        if (!notify) return { memberId: m.id, emailId: null };
        const email = await tx.email.create({
          data: {
            fundId: fund.id,
            type: "MEMBER_INVITED",
            toEmail: m.email,
            memberId: m.id,
            idempotencyKey: `MEMBER_INVITED:member:${m.id}`,
            subject: inviteSubject,
          },
        });
        return { memberId: m.id, emailId: email.id };
      });
    } catch (e) {
      if (isP2002For(e, "paymentReference")) continue;
      if (isP2002For(e, "email")) {
        return {
          error: t("members.admin.errors.emailTaken" as never),
          field: "email",
        };
      }
      throw e;
    }

    if (notify && result.emailId) {
      await sendMemberInvited({
        emailId: result.emailId,
        fundId: fund.id,
        toEmail: parsed.data.email,
        fund: {
          name: fund.name,
          primaryColor: fund.primaryColor,
          logoUrl: fund.logoUrl,
          senderEmail: fund.senderEmail,
        },
        firstName: parsed.data.firstName,
      });
    }

    revalidatePath("/members");
    return { ok: true };
  }

  return { error: t("members.admin.errors.generic" as never) };
}

export type SetReminderOptOutResult =
  | { ok: true; unsubscribed: boolean }
  | { error: string };

// Admin-driven counterpart to the member's own opt-out link (the token-based
// setReminderOptOutAction on the public /unsubscribe page). Lets an operator
// flip a member's reminder subscription from the member detail page — same
// Member.emailUnsubscribed flag the cron and "Remind all" filter on, so opting
// a member out here also stops automatic payment reminders for them.
export async function setMemberReminderOptOutAction(input: {
  memberId: string;
  unsubscribe: boolean;
}): Promise<SetReminderOptOutResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: { id: true },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };

  await prisma.member.update({
    where: { id: member.id },
    data: {
      emailUnsubscribed: input.unsubscribe,
      emailUnsubscribedAt: input.unsubscribe ? new Date() : null,
    },
  });

  revalidatePath("/members");
  revalidatePath(`/members/${member.id}`);
  return { ok: true, unsubscribed: input.unsubscribe };
}

export type DeleteMemberResult = { ok: true } | { error: string };

// Hard delete (issue #109) — permanent, row action on the members list.
// Only allowed when the member has no linked card, no transaction history and
// no referral on either side (see isMemberDeletable): those are exactly the
// members a fund can still safely remove without losing audit trail, e.g. a
// duplicate or a member added by mistake. What's left (linked bank accounts,
// email verifications) cascades and emails detach, per the schema's own rules.
export async function deleteMemberAction(input: {
  memberId: string;
}): Promise<DeleteMemberResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: {
      id: true,
      _count: {
        select: {
          cards: true,
          bankTransactions: true,
          tokenOperations: true,
          sponsoredReferrals: true,
        },
      },
      referralRecord: { select: { id: true } },
    },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };
  if (!isMemberDeletable(member)) {
    return { error: t("members.admin.delete.errors.notDeletable" as never) };
  }

  await prisma.member.delete({ where: { id: member.id } });

  revalidatePath("/members");
  return { ok: true };
}

function isP2002For(e: unknown, field: string): boolean {
  if (!(e instanceof Error) || !("code" in e)) return false;
  if ((e as { code?: string }).code !== "P2002") return false;
  const meta = (e as { meta?: { target?: unknown } }).meta;
  if (!meta?.target) return false;
  const target = Array.isArray(meta.target) ? meta.target : [meta.target];
  return target.some((t) => typeof t === "string" && t.includes(field));
}
