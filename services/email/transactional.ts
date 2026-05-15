// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { renderBrandedEmail } from "./template";
import { sendEmail } from "./resend";

// One function per EmailType that renders the body, calls Resend, and updates
// the queued Email row's status. Callers don't need to handle email failures
// — these functions swallow them (with a console.error) so a missed send
// never blocks the triggering business action (signup, approval, etc.).
//
// Each function takes a `fund: FundBranding` arg so the rendered email
// carries the tenant's own brand (name in the header, primary color on the
// CTA, optional logo). The text body remains the plain-text version.

export type FundBranding = {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
};

export async function sendMemberEmailVerification(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  firstName: string;
  verifyUrl: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("members.signup.emailTemplates.verify");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
          verifyUrl: args.verifyUrl,
        }),
        ctaLabel: t("ctaLabel"),
      };
    },
    to: args.toEmail,
  });
}

export async function sendMemberActivated(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  firstName: string;
  cardSerial: string;
  paymentReference: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("members.admin.email.activated");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
          cardSerial: args.cardSerial,
          paymentReference: args.paymentReference,
        }),
      };
    },
    to: args.toEmail,
  });
}

export async function sendAllocationConfirmation(args: {
  emailId: string;
  toEmail: string;
  firstName: string;
  fund: FundBranding;
  amount: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("members.email.allocationConfirmation");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
          amount: args.amount,
        }),
      };
    },
    to: args.toEmail,
  });
}

export async function sendReferralBonusAwarded(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  firstName: string;
  amount: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations(
        "members.admin.email.referralBonusAwarded",
      );
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
          amount: args.amount,
        }),
      };
    },
    to: args.toEmail,
  });
}

export async function sendPaymentConfirmation(args: {
  emailId: string;
  toEmail: string;
  firstName: string;
  fund: FundBranding;
  amount: string;
  occurredAt: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("members.email.paymentConfirmation");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
          amount: args.amount,
          occurredAt: args.occurredAt,
        }),
      };
    },
    to: args.toEmail,
  });
}

export async function sendMemberWelcome(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  firstName: string;
  paymentReference: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("members.signup.emailTemplates.welcome");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
          paymentReference: args.paymentReference,
        }),
      };
    },
    to: args.toEmail,
  });
}

export async function sendMemberInvited(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  firstName: string;
  paymentReference: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("members.admin.email.invited");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
          paymentReference: args.paymentReference,
        }),
      };
    },
    to: args.toEmail,
  });
}

export async function sendMerchantEmailVerification(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  merchantName: string;
  verifyUrl: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("merchants.signup.email.verify");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          merchantName: args.merchantName,
          fundName: args.fund.name,
          verifyUrl: args.verifyUrl,
        }),
        ctaLabel: t("ctaLabel"),
      };
    },
    to: args.toEmail,
  });
}

export async function sendMerchantApproved(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  merchantName: string;
  citizenPayOnboardingUrl: string | null;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("merchants.admin.email.approved");
      // Two body variants: with the CP onboarding URL (the prod path) and
      // without (env not set in dev → fall back to "admin will be in touch").
      const text = args.citizenPayOnboardingUrl
        ? t("textBodyWithLink", {
            merchantName: args.merchantName,
            fundName: args.fund.name,
            citizenPayUrl: args.citizenPayOnboardingUrl,
          })
        : t("textBodyWithoutLink", {
            merchantName: args.merchantName,
            fundName: args.fund.name,
          });
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text,
        ctaLabel: args.citizenPayOnboardingUrl
          ? t("ctaLabel")
          : undefined,
      };
    },
    to: args.toEmail,
  });
}

export async function sendMerchantRejected(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  merchantName: string;
  reason: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("merchants.admin.email.rejected");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          merchantName: args.merchantName,
          fundName: args.fund.name,
          reason: args.reason,
        }),
      };
    },
    to: args.toEmail,
  });
}

export async function sendMerchantWelcome(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  merchantName: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async () => {
      const t = await getTranslations("merchants.signup.email.welcome");
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          merchantName: args.merchantName,
          fundName: args.fund.name,
        }),
      };
    },
    to: args.toEmail,
  });
}

type RenderedTemplate = {
  subject: string;
  text: string;
  ctaLabel?: string;
};

async function dispatchTemplate(args: {
  emailId: string;
  to: string;
  fund: FundBranding;
  render: () => Promise<RenderedTemplate>;
}): Promise<void> {
  let rendered: RenderedTemplate | null = null;
  let html: string | null = null;
  try {
    rendered = await args.render();
    html = await renderBrandedEmail({
      fundName: args.fund.name,
      primaryColor: args.fund.primaryColor,
      logoUrl: args.fund.logoUrl,
      subject: rendered.subject,
      text: rendered.text,
      ctaLabel: rendered.ctaLabel,
    });
    const { id } = await sendEmail({
      to: args.to,
      subject: rendered.subject,
      text: rendered.text,
      html,
    });
    await prisma.email.update({
      where: { id: args.emailId },
      data: {
        status: "SENT",
        sentAt: new Date(),
        resendMessageId: id,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: html,
      },
    });
  } catch (sendError) {
    const message =
      sendError instanceof Error ? sendError.message : String(sendError);
    try {
      await prisma.email.update({
        where: { id: args.emailId },
        data: {
          status: "FAILED",
          failedAt: new Date(),
          errorMessage: message,
          // Snapshot whatever we managed to render before failing, so the
          // log shows what the recipient would have received.
          ...(rendered
            ? {
                subject: rendered.subject,
                bodyText: rendered.text,
                ...(html ? { bodyHtml: html } : {}),
              }
            : {}),
        },
      });
    } catch (updateError) {
      console.error(
        "[email] failed to mark email as FAILED",
        args.emailId,
        updateError,
      );
    }
    console.error("[email] send failed", args.emailId, message);
  }
}
