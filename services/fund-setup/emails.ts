// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { renderBrandedEmail } from "@/services/email/template";
import { sendEmail } from "@/services/email/resend";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/services/i18n/config";

import { SUBSCRIPTION_MONTHLY_EUR } from "./config";

// The two emails sent once an OWNER accepts the La Caisse hosting subscription
// (Settings → Subscription): a localised, fund-branded confirmation to the
// billing address they gave, and a plain-English notice to Citizen Pay's
// billing mailbox (PLATFORM_BILLING_EMAIL) so ops opens the billing account.
//
// These are not member emails: no Email outbox row, straight through
// sendEmail(). Best-effort — each send is caught and logged, nothing throws,
// because the acceptance is already recorded and runs from after().

export type SubscriptionEmailArgs = {
  fund: {
    id: string;
    name: string;
    domain: string;
    defaultLocale: string;
    primaryColor: string | null;
    logoUrl: string | null;
    citizenPayFundId: string | null;
    citizenPayBusinessId: string | null;
  };
  acceptedAt: Date;
  acceptedByEmail: string;
  billing: { legalName: string; email: string; address: string; vatNumber: string | null };
};

function platformBillingEmail(): string | null {
  const raw = process.env.PLATFORM_BILLING_EMAIL?.trim();
  return raw ? raw : null;
}

export async function sendSubscriptionEmails(args: SubscriptionEmailArgs): Promise<void> {
  const opsEmail = platformBillingEmail();
  await sendConfirmation(args, opsEmail);
  await sendOpsNotice(args, opsEmail);
}

async function sendConfirmation(
  { fund, acceptedAt, acceptedByEmail, billing }: SubscriptionEmailArgs,
  opsEmail: string | null,
): Promise<void> {
  try {
    const locale = isSupportedLocale(fund.defaultLocale) ? fund.defaultLocale : DEFAULT_LOCALE;
    const t = await getTranslations({
      locale,
      namespace: "fund.settings.subscription.email.confirmation",
    });
    const price = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(SUBSCRIPTION_MONTHLY_EUR);
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(acceptedAt);

    const subject = t("subject", { fundName: fund.name });
    const text = t("body", {
      fundName: fund.name,
      fundDomain: fund.domain,
      date,
      userEmail: acceptedByEmail,
      price,
      legalName: billing.legalName,
      address: billing.address,
      vatNumber: billing.vatNumber ?? "—",
    });
    const html = await renderBrandedEmail({
      fundName: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
      subject,
      text,
    });
    await sendEmail({
      to: billing.email,
      subject,
      text,
      html,
      replyTo: opsEmail ?? undefined,
    });
  } catch (e) {
    console.error("[fund-setup] subscription confirmation email failed", e);
  }
}

async function sendOpsNotice(
  { fund, acceptedAt, acceptedByEmail, billing }: SubscriptionEmailArgs,
  opsEmail: string | null,
): Promise<void> {
  if (!opsEmail) {
    console.info("[fund-setup] PLATFORM_BILLING_EMAIL unset — subscription notice not sent", {
      fundId: fund.id,
    });
    return;
  }
  try {
    const text = [
      "A fund accepted the La Caisse hosting subscription.",
      "",
      `Fund: ${fund.name}`,
      `Domain: ${fund.domain}`,
      `Fund id: ${fund.id}`,
      `Citizen Pay treasury id: ${fund.citizenPayFundId ?? "not connected yet"}`,
      `Citizen Pay business id: ${fund.citizenPayBusinessId ?? "not connected yet"}`,
      `Accepted at: ${acceptedAt.toISOString()}`,
      `Accepted by: ${acceptedByEmail}`,
      `Plan: La Caisse hosting, €${SUBSCRIPTION_MONTHLY_EUR} per month, excl. VAT`,
      "",
      "Billing details",
      `Legal name: ${billing.legalName}`,
      `Email: ${billing.email}`,
      `Address:\n${billing.address}`,
      `VAT number: ${billing.vatNumber ?? "—"}`,
      "",
      "Next step: open the billing account for this business on Citizen Pay and start the La Caisse hosting item.",
    ].join("\n");
    await sendEmail({
      to: opsEmail,
      subject: `[La Caisse] Subscription accepted: ${fund.name} (${fund.domain})`,
      text,
      replyTo: billing.email,
    });
  } catch (e) {
    console.error("[fund-setup] subscription ops notice failed", e);
  }
}
