"use server";

import { getTranslations } from "next-intl/server";
import { requireUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { FUND_APEX } from "./host";
import {
  CreateFundSchema,
  SUBDOMAIN_MAX_LENGTH,
  SUBDOMAIN_MIN_LENGTH,
  type CreateFundInput,
} from "./schema";
import { getFundUrl } from "./server";

export type CreateFundResult =
  | { error: string; field?: "name" | "subdomain" }
  | { ok: true; redirectTo: string };

export async function createFundAction(
  input: CreateFundInput,
): Promise<CreateFundResult> {
  const t = await getTranslations();
  const parsed = CreateFundSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never, {
        min: SUBDOMAIN_MIN_LENGTH,
        max: SUBDOMAIN_MAX_LENGTH,
      } as never),
      field: issue.path[0] as "name" | "subdomain" | undefined,
    };
  }

  const user = await requireUser();
  const domain = `${parsed.data.subdomain}.${FUND_APEX}`;

  try {
    const fund = await prisma.fund.create({
      data: {
        name: parsed.data.name,
        domain,
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    return { ok: true, redirectTo: getFundUrl(fund.domain) };
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as { code?: string }).code === "P2002"
    ) {
      return {
        error: t("funds.create.errors.subdomainTaken"),
        field: "subdomain",
      };
    }
    throw e;
  }
}
