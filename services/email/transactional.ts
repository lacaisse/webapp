// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { sendEmail } from "./resend";

// One function per EmailType that renders the body, calls Resend, and updates
// the queued Email row's status. Callers don't need to handle email failures
// — these functions swallow them (with a console.error) so a missed send
// never blocks the triggering business action (signup, approval, etc.).
//
// V1: simple inline HTML wrapper around the localised text body. When we
// add @react-email/components, swap the templates out behind these same
// function signatures.

export async function sendMemberEmailVerification(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  firstName: string;
  verifyUrl: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("members.signup.email.verify");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        firstName: args.firstName,
        fundName: args.fundName,
        verifyUrl: args.verifyUrl,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendMemberActivated(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  firstName: string;
  cardSerial: string;
  paymentReference: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("members.admin.email.activated");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        firstName: args.firstName,
        fundName: args.fundName,
        cardSerial: args.cardSerial,
        paymentReference: args.paymentReference,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendAllocationConfirmation(args: {
  emailId: string;
  toEmail: string;
  firstName: string;
  fundName: string;
  amount: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("members.email.allocationConfirmation");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        firstName: args.firstName,
        fundName: args.fundName,
        amount: args.amount,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendReferralBonusAwarded(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  firstName: string;
  amount: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations(
        "members.admin.email.referralBonusAwarded",
      );
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        firstName: args.firstName,
        fundName: args.fundName,
        amount: args.amount,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendPaymentConfirmation(args: {
  emailId: string;
  toEmail: string;
  firstName: string;
  fundName: string;
  amount: string;
  occurredAt: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("members.email.paymentConfirmation");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        firstName: args.firstName,
        fundName: args.fundName,
        amount: args.amount,
        occurredAt: args.occurredAt,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendMemberWelcome(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  firstName: string;
  paymentReference: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("members.signup.email.welcome");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        firstName: args.firstName,
        fundName: args.fundName,
        paymentReference: args.paymentReference,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendMemberInvited(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  firstName: string;
  paymentReference: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("members.admin.email.invited");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        firstName: args.firstName,
        fundName: args.fundName,
        paymentReference: args.paymentReference,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendMerchantEmailVerification(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  merchantName: string;
  verifyUrl: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("merchants.signup.email.verify");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        merchantName: args.merchantName,
        fundName: args.fundName,
        verifyUrl: args.verifyUrl,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendMerchantApproved(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  merchantName: string;
  citizenPayOnboardingUrl: string | null;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("merchants.admin.email.approved");
      const subject = t("subject", { fundName: args.fundName });
      // Two body variants: with the CP onboarding URL (the prod path) and
      // without (env not set in dev → fall back to "admin will be in touch").
      const text = args.citizenPayOnboardingUrl
        ? t("textBodyWithLink", {
            merchantName: args.merchantName,
            fundName: args.fundName,
            citizenPayUrl: args.citizenPayOnboardingUrl,
          })
        : t("textBodyWithoutLink", {
            merchantName: args.merchantName,
            fundName: args.fundName,
          });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendMerchantRejected(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  merchantName: string;
  reason: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("merchants.admin.email.rejected");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        merchantName: args.merchantName,
        fundName: args.fundName,
        reason: args.reason,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

export async function sendMerchantWelcome(args: {
  emailId: string;
  toEmail: string;
  fundName: string;
  merchantName: string;
}): Promise<void> {
  await dispatchTemplate({
    emailId: args.emailId,
    render: async () => {
      const t = await getTranslations("merchants.signup.email.welcome");
      const subject = t("subject", { fundName: args.fundName });
      const text = t("textBody", {
        merchantName: args.merchantName,
        fundName: args.fundName,
      });
      return { subject, text, html: textToBasicHtml(text) };
    },
    to: args.toEmail,
  });
}

async function dispatchTemplate(args: {
  emailId: string;
  to: string;
  render: () => Promise<{ subject: string; text: string; html: string }>;
}): Promise<void> {
  let rendered: { subject: string; text: string; html: string } | null = null;
  try {
    rendered = await args.render();
    const { id } = await sendEmail({
      to: args.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    await prisma.email.update({
      where: { id: args.emailId },
      data: {
        status: "SENT",
        sentAt: new Date(),
        resendMessageId: id,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
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
                bodyHtml: rendered.html,
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

// Plaintext → minimal inline-styled HTML. Splits on blank lines into <p>
// tags, single newlines become <br>. Escapes HTML entities. Enough for
// transactional emails until proper React Email templates land.
function textToBasicHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  const body = paragraphs
    .map((para) => {
      const lines = para.split("\n").map(escapeHtml).join("<br />");
      return `<p style="margin:0 0 1em 0;">${lines}</p>`;
    })
    .join("\n");
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;line-height:1.5;">${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
