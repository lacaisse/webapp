"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";

import {
  FieldDataSchema,
  StepDataSchema,
  type FieldData,
  type FieldOption,
  type OnboardingFieldResult,
  type OnboardingStepResult,
  type StepData,
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

  // A step from another fund (or another target's form) would leak the step
  // list across tenants and render the field on a page it doesn't belong to.
  const stepId = await resolveStepId(
    fund.id,
    input.target,
    parsed.data.stepId,
  );
  if (stepId === INVALID_STEP) {
    return {
      error: t("onboardingSteps.errors.notFound" as never),
      field: "stepId",
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
        stepId,
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
    select: { id: true, key: true, target: true },
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

  const stepId = await resolveStepId(
    fund.id,
    existing.target,
    parsed.data.stepId,
  );
  if (stepId === INVALID_STEP) {
    return {
      error: t("onboardingSteps.errors.notFound" as never),
      field: "stepId",
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
      stepId,
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

// --- Steps -----------------------------------------------------------------
// Pages of the public signup form. Archiving a step doesn't orphan its
// fields: they fall back to the first step, so the form never loses an input.

export async function createOnboardingStepAction(input: {
  target: "MEMBER" | "MERCHANT";
  data: StepData;
}): Promise<OnboardingStepResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = StepDataSchema.safeParse(input.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as keyof StepData | undefined,
    };
  }

  await prisma.onboardingStep.create({
    data: {
      fundId: fund.id,
      target: input.target,
      title: parsed.data.title,
      description: parsed.data.description || null,
      position: parsed.data.position,
    },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function updateOnboardingStepAction(input: {
  stepId: string;
  data: StepData;
}): Promise<OnboardingStepResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const existing = await prisma.onboardingStep.findFirst({
    where: { id: input.stepId, fundId: fund.id },
    select: { id: true },
  });
  if (!existing) {
    return { error: t("onboardingSteps.errors.notFound" as never) };
  }

  const parsed = StepDataSchema.safeParse(input.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as keyof StepData | undefined,
    };
  }

  await prisma.onboardingStep.update({
    where: { id: existing.id },
    data: {
      title: parsed.data.title,
      description: parsed.data.description || null,
      position: parsed.data.position,
    },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function archiveOnboardingStepAction(input: {
  stepId: string;
}): Promise<OnboardingStepResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const existing = await prisma.onboardingStep.findFirst({
    where: { id: input.stepId, fundId: fund.id },
    select: { id: true },
  });
  if (!existing) {
    return { error: t("onboardingSteps.errors.notFound" as never) };
  }

  await prisma.onboardingStep.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function restoreOnboardingStepAction(input: {
  stepId: string;
}): Promise<OnboardingStepResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const existing = await prisma.onboardingStep.findFirst({
    where: { id: input.stepId, fundId: fund.id },
    select: { id: true },
  });
  if (!existing) {
    return { error: t("onboardingSteps.errors.notFound" as never) };
  }

  await prisma.onboardingStep.update({
    where: { id: existing.id },
    data: { archivedAt: null },
  });

  revalidatePath("/settings");
  return { ok: true };
}

// --- Helpers ---------------------------------------------------------------

const INVALID_STEP = Symbol("invalid-step");

// Resolve a client-supplied stepId to one this fund actually owns for this
// form. Returns null for "no step" (first page) and INVALID_STEP when the id
// doesn't belong to (fund, target) — the caller turns that into an error
// rather than silently dropping the assignment.
async function resolveStepId(
  fundId: string,
  target: "MEMBER" | "MERCHANT",
  stepId: string | null | undefined,
): Promise<string | null | typeof INVALID_STEP> {
  if (!stepId) return null;
  const step = await prisma.onboardingStep.findFirst({
    where: { id: stepId, fundId, target },
    select: { id: true },
  });
  return step ? step.id : INVALID_STEP;
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
