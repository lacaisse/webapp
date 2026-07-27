// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { resolveTreasurySlug } from "@/services/citizenpay/treasury-slug";
import { prisma } from "@/services/db/prisma";
import { resolveRequestedContribution } from "@/services/member/contribution";
import { buildPaymentPageUrl } from "@/services/payment/pay-link";
import { SUPPORTED_LOCALES } from "@/services/i18n/config";
import { sendEmail } from "./resend";
import { renderBrandedEmail } from "./template";
import {
  AssignEmailTemplateSchema,
  CreateEmailTemplateSchema,
  PREVIEW_SAMPLE_VALUES,
  PreviewEmailTemplateSchema,
  RenameEmailTemplateSchema,
  SaveTemplateLocalizationSchema,
  findUnknownPlaceholders,
  type AssignEmailTemplateInput,
  type CreateEmailTemplateInput,
  type EditableEmailType,
  type PreviewEmailTemplateInput,
  type RenameEmailTemplateInput,
  type SaveTemplateLocalizationInput,
} from "./template-config";
import {
  buildCardLink,
  buildShopList,
  formatMemberAddress,
  getEmailTemplateLibrary,
  htmlToPlainText,
  interpolate,
  loadTemplateContentById,
} from "./templates";

export type TemplateActionResult = { ok: true } | { error: string };

// Fund subset every action loads for the branded-render / test-send paths.
type Fund = Awaited<ReturnType<typeof requireFundRole>>["fund"];

// Create a new library template for an email type — either seeded from the
// built-in default (sourceTemplateId null) or duplicated from an existing
// template. Every supported language is prefilled so the template is complete
// from the start; the admin can then tweak each language. The built-in default
// is never touched, so the originals can't be broken. ADMIN-gated, fund-scoped.
export type CreateTemplateResult =
  | { ok: true; templateId: string }
  | { error: string };

export async function createEmailTemplateAction(
  input: CreateEmailTemplateInput,
): Promise<CreateTemplateResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = CreateEmailTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const { type, name, sourceTemplateId } = parsed.data;

  // One load gives us both the built-in default (per language) and the source
  // template to duplicate, all fund-scoped.
  const library = await getEmailTemplateLibrary({ type, fundId: fund.id });
  const source = sourceTemplateId
    ? library.templates.find((tpl) => tpl.id === sourceTemplateId)
    : null;
  if (sourceTemplateId && !source) {
    return { error: t("fund.settings.emailTemplates.errors.notFound" as never) };
  }

  try {
    const created = await prisma.emailTemplate.create({
      data: {
        fundId: fund.id,
        type,
        name,
        localizations: {
          create: SUPPORTED_LOCALES.map((locale) => {
            // A duplicated template may not have authored every language yet;
            // fall back to the built-in default for those.
            const content =
              source?.byLocale[locale] ?? library.defaultByLocale[locale];
            return {
              locale,
              subject: content.subject,
              bodyHtml: content.bodyHtml,
              bodyText: htmlToPlainText(content.bodyHtml),
            };
          }),
        },
      },
      select: { id: true },
    });
    revalidatePath("/emails");
    return { ok: true, templateId: created.id };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return {
        error: t("fund.settings.emailTemplates.errors.nameTaken" as never),
      };
    }
    throw e;
  }
}

// Save one language's content of a library template. Rejects any {token} not in
// the type's allowed variable set so a stored template never renders a broken
// placeholder. The body is rich HTML; a plain-text version is derived for the
// text/plain MIME part. Fund-scoped: the template must belong to the fund.
export async function saveTemplateLocalizationAction(
  input: SaveTemplateLocalizationInput,
): Promise<TemplateActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SaveTemplateLocalizationSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const { templateId, type, locale, subject, bodyHtml } = parsed.data;

  const unknown = findUnknownPlaceholders(type, subject, bodyHtml);
  if (unknown.length > 0) {
    return {
      error: t("fund.settings.emailTemplates.errors.unknownVariable" as never, {
        name: unknown[0],
      } as never),
    };
  }

  // Verify the template is this fund's and of the expected type before writing.
  const template = await prisma.emailTemplate.findFirst({
    where: { id: templateId, fundId: fund.id, type },
    select: { id: true },
  });
  if (!template) {
    return { error: t("fund.settings.emailTemplates.errors.notFound" as never) };
  }

  const bodyText = htmlToPlainText(bodyHtml);
  await prisma.emailTemplateLocalization.upsert({
    where: { templateId_locale: { templateId, locale } },
    create: { templateId, locale, subject, bodyHtml, bodyText },
    update: { subject, bodyHtml, bodyText },
  });

  revalidatePath("/emails");
  return { ok: true };
}

// Rename a library template (unique within a fund + type).
export async function renameEmailTemplateAction(
  input: RenameEmailTemplateInput,
): Promise<TemplateActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = RenameEmailTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const { templateId, name } = parsed.data;

  try {
    const res = await prisma.emailTemplate.updateMany({
      where: { id: templateId, fundId: fund.id },
      data: { name },
    });
    if (res.count === 0) {
      return {
        error: t("fund.settings.emailTemplates.errors.notFound" as never),
      };
    }
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return {
        error: t("fund.settings.emailTemplates.errors.nameTaken" as never),
      };
    }
    throw e;
  }

  revalidatePath("/emails");
  return { ok: true };
}

// Delete a library template. Its assignment (if it was the active one) reverts
// to the built-in default via onDelete: SetNull — no dangling pointer.
export async function deleteEmailTemplateAction(input: {
  templateId: string;
}): Promise<TemplateActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const res = await prisma.emailTemplate.deleteMany({
    where: { id: input.templateId, fundId: fund.id },
  });
  if (res.count === 0) {
    return { error: t("fund.settings.emailTemplates.errors.notFound" as never) };
  }

  revalidatePath("/emails");
  return { ok: true };
}

// Choose which template a fund sends for an email type. templateId null reverts
// to the built-in default. Fund-scoped: a non-null template must belong to the
// fund and match the type.
export async function setActiveEmailTemplateAction(
  input: AssignEmailTemplateInput,
): Promise<TemplateActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = AssignEmailTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const { type, templateId } = parsed.data;

  if (templateId) {
    const template = await prisma.emailTemplate.findFirst({
      where: { id: templateId, fundId: fund.id, type },
      select: { id: true },
    });
    if (!template) {
      return {
        error: t("fund.settings.emailTemplates.errors.notFound" as never),
      };
    }
  }

  await prisma.emailTemplateAssignment.upsert({
    where: { fundId_type: { fundId: fund.id, type } },
    create: { fundId: fund.id, type, templateId },
    update: { templateId },
  });

  revalidatePath("/emails");
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

// Test-send picker member shape (mirrors what the panel loads).
type TestMember = {
  firstName: string;
  lastName: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  contributionAmount: unknown;
  tier: { allocationAmount: { toString(): string } } | null;
  primaryCard: {
    serialNumber: string;
    number: number | null;
  } | null;
};

// Build the {placeholder} values for a test send. Uses the picked member's real
// data where the type references it, filling anything the member lacks (or when
// no member is picked) from the type's illustrative sample values. Returns the
// text-side vars plus optional html-only overrides (allocation's {shopList}).
async function buildTestVars(
  fund: Fund,
  type: EditableEmailType,
  member: TestMember | null,
): Promise<{ vars: Record<string, string>; htmlVars?: Record<string, string> }> {
  const sample = PREVIEW_SAMPLE_VALUES[type] as Record<string, string>;
  if (!member) {
    return { vars: { ...sample, fundName: fund.name } };
  }

  const card = member.primaryCard;
  const serial = card?.serialNumber ?? sample.paymentReference ?? "";
  const slug = card ? await resolveTreasurySlug(fund) : null;

  let amount = sample.amount ?? "";
  if (member.tier) {
    if (type === "PAYMENT_REMINDER_FIRST" || type === "PAYMENT_REMINDER_SECOND") {
      amount = resolveRequestedContribution(
        member.contributionAmount as never,
        member.tier.allocationAmount as never,
      );
    } else if (type === "ALLOCATION_CONFIRMATION") {
      amount = member.tier.allocationAmount.toString();
    }
  }

  const vars: Record<string, string> = {
    fundName: fund.name,
    firstName: member.firstName || (sample.firstName ?? ""),
    lastName: member.lastName ?? "",
    amount,
    cardSerial: serial,
    paymentReference: serial,
    cardLink: card ? buildCardLink(serial, slug) : (sample.cardLink ?? ""),
    paymentLink: card
      ? buildPaymentPageUrl(fund.domain, serial)
      : (sample.paymentLink ?? ""),
    cardNumber:
      card?.number != null ? String(card.number) : (sample.cardNumber ?? ""),
    address: formatMemberAddress(member),
    occurredAt: sample.occurredAt ?? "",
  };

  let htmlVars: Record<string, string> | undefined;
  if (type === "ALLOCATION_CONFIRMATION") {
    const shop = await buildShopList(fund.id);
    vars.shopList = shop.text;
    htmlVars = { shopList: shop.html };
  }

  return { vars, htmlVars };
}

// Send a one-off test of a specific template (or the built-in default when
// templateId is null) to an admin-specified address, in the language currently
// being edited. Populated from a picked member's live data where relevant, else
// from sample values. Transient — no Email row / idempotency. Honours the
// fund's custom sender so the test reflects exactly what members receive.
export async function sendTestEmailAction(input: {
  type: EditableEmailType;
  // The template to test; null tests the built-in default.
  templateId: string | null;
  // The member to seed data from (optional); null uses sample values.
  memberId: string | null;
  toEmail: string;
  locale: string;
}): Promise<SendTestEmailResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const toEmail = input.toEmail.trim();
  if (!z.string().email().safeParse(toEmail).success) {
    return {
      error: t("fund.settings.emailTemplates.test.errors.emailInvalid" as never),
    };
  }

  let member: TestMember | null = null;
  if (input.memberId) {
    member = await prisma.member.findFirst({
      where: { id: input.memberId, fundId: fund.id },
      select: {
        firstName: true,
        lastName: true,
        address: true,
        postalCode: true,
        city: true,
        contributionAmount: true,
        tier: { select: { allocationAmount: true } },
        primaryCard: { select: { serialNumber: true, number: true } },
      },
    });
    if (!member) {
      return {
        error: t(
          "fund.settings.emailTemplates.test.errors.memberNotFound" as never,
        ),
      };
    }
  }

  const { vars, htmlVars } = await buildTestVars(fund, input.type, member);
  const content = await loadTemplateContentById({
    fundId: fund.id,
    type: input.type,
    templateId: input.templateId,
    locale: input.locale,
  });

  const subject = `${t("fund.settings.emailTemplates.test.subjectPrefix" as never)} ${interpolate(content.subject, vars)}`;
  const text = interpolate(content.bodyText, vars);
  const html = await renderBrandedEmail({
    fundName: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
    subject,
    text,
    html: content.bodyHtml
      ? interpolate(
          content.bodyHtml,
          htmlVars ? { ...vars, ...htmlVars } : vars,
        )
      : undefined,
  });

  try {
    await sendEmail({
      to: toEmail,
      subject,
      text,
      html,
      from: fund.senderEmail
        ? `${fund.name} <${fund.senderEmail}>`
        : undefined,
    });
  } catch (e) {
    const safeTypeForLog = String(input.type).replace(/[\r\n]/g, "");
    console.error("[email] test send failed", fund.id, safeTypeForLog, e);
    return {
      error: t("fund.settings.emailTemplates.test.errors.sendFailed" as never),
    };
  }
  return { ok: true };
}
