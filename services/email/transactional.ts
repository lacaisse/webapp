// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { getFundUrl } from "@/services/fund/server";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/services/i18n/config";
import { buildUnsubscribeToken } from "@/services/member/unsubscribe";
import { renderBrandedEmail } from "./template";
import {
  resolveAllocationTemplate,
  resolveCardAssignedTemplate,
  resolvePaymentReminderTemplate,
} from "./templates";
import { sendEmail } from "./resend";

// One function per EmailType that renders the body, calls Resend, and updates
// the queued Email row's status. Callers don't need to handle email failures
// — these functions swallow them (with a console.error) so a missed send
// never blocks the triggering business action (signup, approval, etc.).
//
// Each function takes a `fund: FundBranding` arg so the rendered email
// carries the tenant's own brand (name in the header, primary color on the
// CTA, optional logo). The text body remains the plain-text version.
//
// Language: senders never pass a locale. `dispatchTemplate` resolves it once
// from the queued Email row — the member's own `Member.locale` (captured at
// signup) for member emails, falling back to the fund's default locale then
// the platform default — and threads it into every `render(locale)` callback
// and the opt-out footer. So a member always gets email in their language,
// regardless of who (admin / cron) triggered the send. See resolveEmailLocale.

export type FundBranding = {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
  // Optional per-fund From address. When set, the email is sent from
  // "<name> <senderEmail>" instead of the platform default. Only the
  // member-facing senders thread this through (merchant/team sends leave it
  // undefined and keep the platform EMAIL_FROM).
  senderEmail?: string | null;
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
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "members.signup.emailTemplates.verify",
      });
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
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "members.admin.email.activated",
      });
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
  fundId: string;
  toEmail: string;
  firstName: string;
  lastName: string;
  // Recipient wallet address (TokenOperation.account) — used to resolve the
  // {cardSerial} variable. Pass null if unknown.
  account: string | null;
  fund: FundBranding;
  amount: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    // Prefer the fund's editable override (services/email/templates.ts),
    // falling back to the i18n default. {placeholder} tokens are interpolated
    // inside the resolver.
    render: (locale) =>
      resolveAllocationTemplate({
        fundId: args.fundId,
        account: args.account,
        locale,
        vars: {
          firstName: args.firstName,
          lastName: args.lastName,
          fundName: args.fund.name,
          amount: args.amount,
        },
      }),
    to: args.toEmail,
  });
}

export async function sendCardAssigned(args: {
  emailId: string;
  fundId: string;
  toEmail: string;
  fund: FundBranding;
  firstName: string;
  lastName: string;
  // Pre-resolved scalars (see services/email/templates.ts): formatted postal
  // address, public tap URL, per-fund card number.
  address: string;
  cardLink: string;
  cardNumber: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    // Prefer the fund's editable override, falling back to the i18n default.
    render: (locale) =>
      resolveCardAssignedTemplate({
        fundId: args.fundId,
        locale,
        vars: {
          firstName: args.firstName,
          lastName: args.lastName,
          fundName: args.fund.name,
          address: args.address,
          cardLink: args.cardLink,
          cardNumber: args.cardNumber,
        },
      }),
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
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "members.admin.email.referralBonusAwarded",
      });
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
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "members.email.paymentConfirmation",
      });
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

export async function sendPaymentReminder(args: {
  emailId: string;
  fundId: string;
  toEmail: string;
  fund: FundBranding;
  firstName: string;
  lastName: string;
  // The member's expected monthly contribution (tier target amount), already
  // stringified. "" when the member has no tier assigned.
  amount: string;
  // Bank-transfer communication bank-sync matches on.
  paymentReference: string;
  // Public account / tap URL ({cardLink}); "" when the member has no card.
  cardLink: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    // Prefer the fund's editable override, falling back to the HTML default.
    render: (locale) =>
      resolvePaymentReminderTemplate({
        fundId: args.fundId,
        locale,
        vars: {
          firstName: args.firstName,
          lastName: args.lastName,
          fundName: args.fund.name,
          amount: args.amount,
          paymentReference: args.paymentReference,
          cardLink: args.cardLink,
        },
      }),
    to: args.toEmail,
  });
}

export async function sendMemberWelcome(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  firstName: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "members.signup.emailTemplates.welcome",
      });
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
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
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "members.admin.email.invited",
      });
      return {
        subject: t("subject", { fundName: args.fund.name }),
        text: t("textBody", {
          firstName: args.firstName,
          fundName: args.fund.name,
        }),
      };
    },
    to: args.toEmail,
  });
}

export async function sendFundInvited(args: {
  emailId: string;
  toEmail: string;
  fund: FundBranding;
  role: string;
  acceptUrl: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    fund: args.fund,
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "team.admin.email.invited",
      });
      const roleLabel = await getTranslations({ locale, namespace: "team.roles" });
      return {
        subject: t("subject", { fundName: args.fund.name }),
        // The bare-URL paragraph renders as the primary CTA button.
        text: t("textBody", {
          fundName: args.fund.name,
          role: roleLabel(args.role as never),
          acceptUrl: args.acceptUrl,
        }),
        ctaLabel: t("ctaLabel"),
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
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "merchants.signup.email.verify",
      });
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
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "merchants.admin.email.approved",
      });
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
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "merchants.admin.email.rejected",
      });
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
    render: async (locale) => {
      const t = await getTranslations({
        locale,
        namespace: "merchants.signup.email.welcome",
      });
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
  // Rich-HTML body. When set, it's injected into the branded shell and `text`
  // is used only for the plain-text MIME part.
  html?: string;
};

// The opt-out footer for a queued email (issue #40). Built from the Email row
// already loaded by dispatchTemplate (memberId + fund domain) so every
// member-facing send carries the deregistration link without each sender
// threading it through. Returns undefined for merchant / team emails (no
// member) so they get no link. `locale` matches the rest of the email.
async function buildUnsubscribeFooter(
  row: { memberId: string | null; fund: { domain: string } | null },
  locale: string,
): Promise<{ url: string; label: string } | undefined> {
  if (!row.memberId || !row.fund) return undefined;
  const t = await getTranslations({ locale, namespace: "members.email.footer" });
  const token = buildUnsubscribeToken(row.memberId);
  return {
    url: `${getFundUrl(row.fund.domain)}/unsubscribe?token=${encodeURIComponent(token)}`,
    label: t("unsubscribe"),
  };
}

// The language every member-facing email is rendered in. A member's own
// `Member.locale` (captured at signup) wins so the email matches the language
// they registered in; merchant / team emails have no member and fall back to
// the fund's default locale, then the platform default. Anything unsupported
// (null, a legacy value) is ignored in favour of the next fallback.
function resolveEmailLocale(row: {
  member: { locale: string | null } | null;
  fund: { defaultLocale: string } | null;
}): string {
  const candidates = [row.member?.locale, row.fund?.defaultLocale];
  for (const c of candidates) {
    if (c && isSupportedLocale(c)) return c;
  }
  return DEFAULT_LOCALE;
}

async function dispatchTemplate(args: {
  emailId: string;
  to: string;
  fund: FundBranding;
  render: (locale: string) => Promise<RenderedTemplate>;
}): Promise<void> {
  let rendered: RenderedTemplate | null = null;
  let html: string | null = null;
  try {
    // One lookup drives both the recipient's language and the opt-out footer.
    const row = await prisma.email.findUnique({
      where: { id: args.emailId },
      select: {
        memberId: true,
        member: { select: { locale: true } },
        fund: { select: { domain: true, defaultLocale: true } },
      },
    });
    const locale = resolveEmailLocale(row ?? { member: null, fund: null });
    rendered = await args.render(locale);
    const unsubscribe = row
      ? await buildUnsubscribeFooter(row, locale)
      : undefined;
    html = await renderBrandedEmail({
      fundName: args.fund.name,
      primaryColor: args.fund.primaryColor,
      logoUrl: args.fund.logoUrl,
      subject: rendered.subject,
      text: rendered.text,
      ctaLabel: rendered.ctaLabel,
      html: rendered.html,
      unsubscribe,
    });
    const { id } = await sendEmail({
      to: args.to,
      subject: rendered.subject,
      text: rendered.text,
      html,
      // Per-fund sender (member emails only); falls back to EMAIL_FROM when
      // the fund hasn't configured one.
      from: args.fund.senderEmail
        ? `${args.fund.name} <${args.fund.senderEmail}>`
        : undefined,
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
