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
  type AcceptSubscriptionInput,
} from "./schema";

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

  const values = parsed.data;
  const billing = {
    legalName: values.legalName,
    email: values.email,
    address: values.address,
    vatNumber: values.vatNumber === "" ? null : values.vatNumber,
  };
  const now = new Date();

  const { count } = await prisma.fund.updateMany({
    where: { id: fund.id, subscriptionAcceptedAt: null },
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
    // Someone else's submit won the race: report their acceptance, send nothing.
    const existing = await prisma.fund.findUnique({
      where: { id: fund.id },
      select: { subscriptionAcceptedAt: true },
    });
    revalidatePath("/settings");
    revalidatePath("/dashboard");
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
