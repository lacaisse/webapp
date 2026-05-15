"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";

import {
  FieldDataSchema,
  type FieldData,
  type FieldOption,
  type OnboardingFieldResult,
} from "./schema";

// CRUD for OnboardingField rows. Keys are immutable after creation —
// stored applicationData blobs reference them by key, so changing a key
// would silently orphan all historical responses for that field.

export async function createOnboardingFieldAction(input: {
  target: "MEMBER" | "MERCHANT";
  data: FieldData;
}): Promise<OnboardingFieldResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = FieldDataSchema.safeParse(input.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as keyof FieldData | undefined,
    };
  }

  try {
    await prisma.onboardingField.create({
      data: {
        fundId: fund.id,
        target: input.target,
        key: parsed.data.key,
        type: parsed.data.type,
        label: parsed.data.label,
        helpText: parsed.data.helpText || null,
        required: parsed.data.required,
        position: parsed.data.position,
        config: configFor(parsed.data.type, parsed.data.options),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return {
        error: t("onboardingFields.errors.keyTaken" as never),
        field: "key",
      };
    }
    throw e;
  }

  revalidatePath("/settings");
  return { ok: true };
}

export async function updateOnboardingFieldAction(input: {
  fieldId: string;
  data: FieldData;
}): Promise<OnboardingFieldResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const existing = await prisma.onboardingField.findFirst({
    where: { id: input.fieldId, fundId: fund.id },
    select: { id: true, key: true },
  });
  if (!existing) {
    return { error: t("onboardingFields.errors.notFound" as never) };
  }

  const parsed = FieldDataSchema.safeParse(input.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as keyof FieldData | undefined,
    };
  }

  // Key is immutable. Silently ignore any mismatch from the client.
  await prisma.onboardingField.update({
    where: { id: existing.id },
    data: {
      type: parsed.data.type,
      label: parsed.data.label,
      helpText: parsed.data.helpText || null,
      required: parsed.data.required,
      position: parsed.data.position,
      config: configFor(parsed.data.type, parsed.data.options),
    },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function archiveOnboardingFieldAction(input: {
  fieldId: string;
}): Promise<OnboardingFieldResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const existing = await prisma.onboardingField.findFirst({
    where: { id: input.fieldId, fundId: fund.id },
    select: { id: true },
  });
  if (!existing) {
    return { error: t("onboardingFields.errors.notFound" as never) };
  }

  await prisma.onboardingField.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function restoreOnboardingFieldAction(input: {
  fieldId: string;
}): Promise<OnboardingFieldResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const existing = await prisma.onboardingField.findFirst({
    where: { id: input.fieldId, fundId: fund.id },
    select: { id: true },
  });
  if (!existing) {
    return { error: t("onboardingFields.errors.notFound" as never) };
  }

  await prisma.onboardingField.update({
    where: { id: existing.id },
    data: { archivedAt: null },
  });

  revalidatePath("/settings");
  return { ok: true };
}

function configFor(
  type: FieldData["type"],
  options: FieldOption[] | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (type === "SELECT" || type === "MULTISELECT") {
    return { options: options ?? [] };
  }
  return Prisma.JsonNull;
}
