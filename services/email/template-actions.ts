// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { resolveTreasurySlug } from "@/services/citizenpay/treasury-slug";
import { prisma } from "@/services/db/prisma";
import { sendEmail } from "./resend";
import { renderBrandedEmail } from "./template";
import {
  PREVIEW_SAMPLE_VALUES,
  PreviewEmailTemplateSchema,
  SaveEmailTemplateSchema,
  findUnknownPlaceholders,
  type PreviewEmailTemplateInput,
  type SaveEmailTemplateInput,
} from "./template-config";
import {
  buildCardLink,
  buildShopList,
  formatMemberAddress,
  htmlToPlainText,
  interpolate,
  resolveAllocationTemplate,
  resolveCardAssignedTemplate,
  resolvePaymentReminderTemplate,
} from "./templates";

export type TemplateActionResult = { ok: true } | { error: string };

// Save (create or replace) a fund's override for an editable email template.
// Re-validates the shared schema and rejects any {token} not in the template's
// allowed variable set, so a stored template never renders a broken
// placeholder. The body is rich HTML; a plain-text version is derived for the
// text/plain MIME part. ADMIN-gated like the other fund settings.
export async function saveEmailTemplateAction(
  input: SaveEmailTemplateInput,
): Promise<TemplateActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SaveEmailTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const { type, subject, bodyHtml } = parsed.data;

  const unknown = findUnknownPlaceholders(type, subject, bodyHtml);
  if (unknown.length > 0) {
    return {
      error: t("fund.settings.emailTemplates.errors.unknownVariable" as never, {
        name: unknown[0],
      } as never),
    };
  }

  const bodyText = htmlToPlainText(bodyHtml);
  await prisma.emailTemplate.upsert({
    where: { fundId_type: { fundId: fund.id, type } },
    create: { fundId: fund.id, type, subject, bodyHtml, bodyText },
    update: { subject, bodyHtml, bodyText },
  });

  revalidatePath("/settings");
  return { ok: true };
}

// Drop a fund's override so the built-in i18n default takes over again.
export async function resetEmailTemplateAction(input: {
  type: SaveEmailTemplateInput["type"];
}): Promise<TemplateActionResult> {
  const { fund } = await requireFundRole("ADMIN");
  await prisma.emailTemplate.deleteMany({
    where: { fundId: fund.id, type: input.type },
  });
  revalidatePath("/settings");
  return { ok: true };
}

export type PreviewResult = { ok: true; html: string } | { error: string };

// Render the live editor preview: interpolate the draft subject/body with
// sample values, wrap in the fund's branded shell, and return the full HTML
// document for the editor to show in a sandboxed iframe. Never persists.
export async function previewEmailTemplateAction(
  input: PreviewEmailTemplateInput,
): Promise<PreviewResult> {
  const { fund } = await requireFundRole("ADMIN");
  const parsed = PreviewEmailTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "invalid" };
  }
  const { type, subject, bodyHtml } = parsed.data;

  // Preview shows the real active-merchant list so {shopList} looks accurate.
  const shop = await buildShopList(fund.id);
  const scalar = { ...PREVIEW_SAMPLE_VALUES[type], fundName: fund.name };
  const html = await renderBrandedEmail({
    fundName: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
    subject: interpolate(subject, { ...scalar, shopList: shop.text }),
    text: "",
    html: interpolate(bodyHtml, { ...scalar, shopList: shop.html }),
  });
  return { ok: true, html };
}

export type SendTestEmailResult = { ok: true } | { error: string };

// Send a one-off test of the ALLOCATION_CONFIRMATION email to an
// admin-specified address, populated from a real member so the variables
// ({firstName}, {amount}, {cardSerial}, {shopList}) render with live data.
// The {amount} is the member's tier allocation amount — the "montant cible"
// that actually gets minted to their card — matching the real send.
//
// Renders + sends directly (no Email row, no idempotency): it's a transient
// admin tool, not a tracked member notification. Honours the fund's custom
// sender so the test reflects exactly what members would receive.
export async function sendTestAllocationEmailAction(input: {
  memberId: string;
  toEmail: string;
}): Promise<SendTestEmailResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const toEmail = input.toEmail.trim();
  if (!z.string().email().safeParse(toEmail).success) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.emailInvalid" as never),
    };
  }

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: {
      firstName: true,
      lastName: true,
      tier: { select: { allocationAmount: true } },
      primaryCard: { select: { account: true } },
    },
  });
  if (!member) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.memberNotFound" as never),
    };
  }
  if (!member.tier) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.noTier" as never),
    };
  }

  const rendered = await resolveAllocationTemplate({
    fundId: fund.id,
    account: member.primaryCard?.account ?? null,
    locale: fund.defaultLocale,
    vars: {
      firstName: member.firstName,
      lastName: member.lastName,
      fundName: fund.name,
      amount: member.tier.allocationAmount.toString(),
    },
  });

  const subject = `${t("fund.settings.emailTemplates.test.subjectPrefix" as never)} ${rendered.subject}`;
  const html = await renderBrandedEmail({
    fundName: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
    subject,
    text: rendered.text,
    html: rendered.html,
  });

  try {
    await sendEmail({
      to: toEmail,
      subject,
      text: rendered.text,
      html,
      from: fund.senderEmail
        ? `${fund.name} <${fund.senderEmail}>`
        : undefined,
    });
  } catch (e) {
    console.error("[email] test allocation send failed", fund.id, e);
    return {
      error: t("fund.settings.emailTemplates.test.errors.sendFailed" as never),
    };
  }
  return { ok: true };
}

// Send a one-off test of the CARD_ASSIGNED email, populated from a real
// member's primary card so {address}, {cardLink} and {cardNumber} render with
// live data. Transient (no Email row / idempotency) — same as the allocation
// test. Honours the fund's custom sender.
export async function sendTestCardAssignedEmailAction(input: {
  memberId: string;
  toEmail: string;
}): Promise<SendTestEmailResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const toEmail = input.toEmail.trim();
  if (!z.string().email().safeParse(toEmail).success) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.emailInvalid" as never),
    };
  }

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: {
      firstName: true,
      lastName: true,
      address: true,
      postalCode: true,
      city: true,
      primaryCard: { select: { serialNumber: true, number: true } },
    },
  });
  if (!member) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.memberNotFound" as never),
    };
  }
  if (!member.primaryCard) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.noCard" as never),
    };
  }

  const rendered = await resolveCardAssignedTemplate({
    fundId: fund.id,
    locale: fund.defaultLocale,
    vars: {
      firstName: member.firstName,
      lastName: member.lastName,
      fundName: fund.name,
      address: formatMemberAddress(member),
      cardLink: buildCardLink(
        member.primaryCard.serialNumber,
        await resolveTreasurySlug(fund),
      ),
      cardNumber:
        member.primaryCard.number != null
          ? String(member.primaryCard.number)
          : "",
    },
  });

  const subject = `${t("fund.settings.emailTemplates.test.subjectPrefix" as never)} ${rendered.subject}`;
  const html = await renderBrandedEmail({
    fundName: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
    subject,
    text: rendered.text,
    html: rendered.html,
  });

  try {
    await sendEmail({
      to: toEmail,
      subject,
      text: rendered.text,
      html,
      from: fund.senderEmail
        ? `${fund.name} <${fund.senderEmail}>`
        : undefined,
    });
  } catch (e) {
    console.error("[email] test card-assigned send failed", fund.id, e);
    return {
      error: t("fund.settings.emailTemplates.test.errors.sendFailed" as never),
    };
  }
  return { ok: true };
}

// Send a one-off test of the PAYMENT_REMINDER_FIRST email, populated from a
// real member so {amount} (tier minimum), {paymentReference} and {cardLink}
// render with live data. Requires a tier (for the amount) and a primary card
// (for the link), matching what the real reminder cron needs. Transient — no
// Email row / idempotency. Honours the fund's custom sender.
export async function sendTestPaymentReminderEmailAction(input: {
  memberId: string;
  toEmail: string;
}): Promise<SendTestEmailResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const toEmail = input.toEmail.trim();
  if (!z.string().email().safeParse(toEmail).success) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.emailInvalid" as never),
    };
  }

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: {
      firstName: true,
      lastName: true,
      paymentReference: true,
      tier: { select: { allocationAmount: true } },
      primaryCard: { select: { serialNumber: true } },
    },
  });
  if (!member) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.memberNotFound" as never),
    };
  }
  if (!member.tier) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.noTier" as never),
    };
  }
  if (!member.primaryCard) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.noCard" as never),
    };
  }

  const rendered = await resolvePaymentReminderTemplate({
    fundId: fund.id,
    locale: fund.defaultLocale,
    vars: {
      firstName: member.firstName,
      lastName: member.lastName,
      fundName: fund.name,
      amount: member.tier.allocationAmount.toString(),
      paymentReference: member.paymentReference ?? "",
      cardLink: buildCardLink(
        member.primaryCard.serialNumber,
        await resolveTreasurySlug(fund),
      ),
    },
  });

  const subject = `${t("fund.settings.emailTemplates.test.subjectPrefix" as never)} ${rendered.subject}`;
  const html = await renderBrandedEmail({
    fundName: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
    subject,
    text: rendered.text,
    html: rendered.html,
  });

  try {
    await sendEmail({
      to: toEmail,
      subject,
      text: rendered.text,
      html,
      from: fund.senderEmail
        ? `${fund.name} <${fund.senderEmail}>`
        : undefined,
    });
  } catch (e) {
    console.error("[email] test payment-reminder send failed", fund.id, e);
    return {
      error: t("fund.settings.emailTemplates.test.errors.sendFailed" as never),
    };
  }
  return { ok: true };
}
