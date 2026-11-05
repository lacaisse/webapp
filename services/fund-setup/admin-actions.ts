// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

import { sendSubscriptionEmails } from "./emails";
import {
  AcceptSubscriptionSchema,
  BILLING_LEGAL_NAME_MAX,
  BILLING_LEGAL_NAME_MIN,
  RedeemWaiverCodeSchema,
  type AcceptSubscriptionInput,
  type RedeemWaiverCodeInput,
} from "./schema";
import { claimWaiverCodeUse } from "./waiver-claim";
import { waiverCodeState, type WaiverCodeState } from "./waiver-codes";

type AcceptSubscriptionField = "legalName" | "email" | "address" | "vatNumber" | "accepted";

export type AcceptSubscriptionResult =
  // alreadyAccepted: this submit didn't record anything — the fund had already
  // accepted, or a concurrent submit won the write (no emails were sent for it).
  | { ok: true; acceptedAt: string; alreadyAccepted: boolean }
  | { error: string; field?: AcceptSubscriptionField };

// Settings → Subscription: an OWNER accepts the La Caisse hosting plan
// (SUBSCRIPTION_MONTHLY_EUR per month, invoiced by Citizen Pay) and records the
// billing details. Committing the fund to a monthly payment is the owner's
// call, so ADMIN is not enough.
//
// Idempotent: the write is conditional on `subscriptionAcceptedAt` still being
// null, so a double submit (or two owners at once) records one acceptance and
// sends one pair of emails. The app never clears the acceptance.
export async function acceptSubscriptionAction(
  input: AcceptSubscriptionInput,
): Promise<AcceptSubscriptionResult> {
  const { user, fund } = await requireFundRole("OWNER");

  const parsed = AcceptSubscriptionSchema.safeParse(input);
  if (!parsed.success) {
    const t = await getTranslations();
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never, {
        min: BILLING_LEGAL_NAME_MIN,
        max: BILLING_LEGAL_NAME_MAX,
      } as never),
      field: issue.path[0] as AcceptSubscriptionField | undefined,
    };
  }

  if (fund.subscriptionAcceptedAt) {
    return {
      ok: true,
      acceptedAt: fund.subscriptionAcceptedAt.toISOString(),
      alreadyAccepted: true,
    };
  }
  // Hosting is free for this fund: there is nothing to accept, and recording
  // an acceptance would turn a waived fund into a billed one.
  if (fund.subscriptionWaivedAt) {
    const t = await getTranslations("fund.settings.subscription.errors");
    return { error: t("waived") };
  }

  const values = parsed.data;
  const billing = {
    legalName: values.legalName,
    email: values.email,
    address: values.address,
    vatNumber: values.vatNumber === "" ? null : values.vatNumber,
  };
  const now = new Date();

  const { count } = await prisma.fund.updateMany({
    where: { id: fund.id, subscriptionAcceptedAt: null, subscriptionWaivedAt: null },
    data: {
      subscriptionAcceptedAt: now,
      subscriptionAcceptedByUserId: user.id,
      billingLegalName: billing.legalName,
      billingEmail: billing.email,
      billingAddress: billing.address,
      billingVatNumber: billing.vatNumber,
    },
  });

  if (count === 0) {
    // Someone else's submit won the race: report their acceptance, send
    // nothing. (Or a waiver code was redeemed meanwhile — then say so.)
    const existing = await prisma.fund.findUnique({
      where: { id: fund.id },
      select: { subscriptionAcceptedAt: true, subscriptionWaivedAt: true },
    });
    revalidatePath("/settings");
    revalidatePath("/dashboard");
    if (!existing?.subscriptionAcceptedAt && existing?.subscriptionWaivedAt) {
      const t = await getTranslations("fund.settings.subscription.errors");
      return { error: t("waived") };
    }
    return {
      ok: true,
      acceptedAt: (existing?.subscriptionAcceptedAt ?? now).toISOString(),
      alreadyAccepted: true,
    };
  }

  // Emails run after the response and never fail the acceptance.
  after(async () => {
    await sendSubscriptionEmails({
      fund: {
        id: fund.id,
        name: fund.name,
        domain: fund.domain,
        defaultLocale: fund.defaultLocale,
        primaryColor: fund.primaryColor,
        logoUrl: fund.logoUrl,
        citizenPayFundId: fund.citizenPayFundId,
        citizenPayBusinessId: fund.citizenPayBusinessId,
      },
      acceptedAt: now,
      acceptedByEmail: user.email,
      billing,
    });
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { ok: true, acceptedAt: now.toISOString(), alreadyAccepted: false };
}

// =============================================================================
// Waiver codes — "Have an invite code?" on Settings → Subscription
// =============================================================================

export type RedeemWaiverCodeResult =
  | { ok: true; reason: string }
  | { error: string };

class FundAlreadySettled extends Error {}

const CODE_STATE_ERROR: Record<Exclude<WaiverCodeState, "active">, string> = {
  revoked: "codeRevoked",
  expired: "codeExpired",
  exhausted: "codeExhausted",
};

// An OWNER redeems a waiver code minted by a platform admin: the fund's
// hosting is free, the subscription step is done, no billing details, no
// emails. OWNER for the same reason acceptance is: it settles the fund's
// hosting question.
//
// Two conditional writes in one transaction: the code's use is claimed
// (still active, a use left) and the fund is marked waived (neither accepted
// nor waived yet). If the fund write finds nothing to do, the transaction is
// rolled back so the claimed use goes back to the code.
export async function redeemWaiverCodeAction(
  input: RedeemWaiverCodeInput,
): Promise<RedeemWaiverCodeResult> {
  const { fund } = await requireFundRole("OWNER");
  const t = await getTranslations("fund.settings.subscription.errors");

  const parsed = RedeemWaiverCodeSchema.safeParse(input);
  if (!parsed.success) {
    const tRoot = await getTranslations();
    return { error: tRoot(parsed.error.issues[0].message as never) };
  }
  if (fund.subscriptionAcceptedAt) return { error: t("alreadyAccepted") };
  if (fund.subscriptionWaivedAt) return { error: t("alreadyWaived") };

  const code = await prisma.subscriptionWaiverCode.findUnique({
    where: { code: parsed.data.code },
  });
  if (!code) return { error: t("codeInvalid") };
  const state = waiverCodeState(code);
  if (state !== "active") return { error: t(CODE_STATE_ERROR[state]) };

  const now = new Date();
  let outcome: "waived" | "code_unusable" | "fund_settled";
  try {
    outcome = await prisma.$transaction(async (tx) => {
      if (!(await claimWaiverCodeUse(tx, code, now))) return "code_unusable";

      const waived = await tx.fund.updateMany({
        where: { id: fund.id, subscriptionAcceptedAt: null, subscriptionWaivedAt: null },
        data: {
          subscriptionWaivedAt: now,
          subscriptionWaiverReason: code.label,
          subscriptionWaiverCodeId: code.id,
        },
      });
      if (waived.count === 0) throw new FundAlreadySettled();
      return "waived";
    });
  } catch (e) {
    if (!(e instanceof FundAlreadySettled)) throw e;
    outcome = "fund_settled";
  }

  if (outcome === "code_unusable") {
    // Lost a race with another redemption or a revoke: say what the code is now.
    const fresh = await prisma.subscriptionWaiverCode.findUnique({ where: { id: code.id } });
    const freshState = fresh ? waiverCodeState(fresh, now) : "revoked";
    return {
      error: t(freshState === "active" ? "codeInvalid" : CODE_STATE_ERROR[freshState]),
    };
  }

  revalidatePath("/settings");
  revalidatePath("/dashboard");

  if (outcome === "fund_settled") {
    const existing = await prisma.fund.findUnique({
      where: { id: fund.id },
      select: { subscriptionAcceptedAt: true },
    });
    return { error: t(existing?.subscriptionAcceptedAt ? "alreadyAccepted" : "alreadyWaived") };
  }
  return { ok: true, reason: code.label };
}
