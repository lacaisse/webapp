// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getLocale, getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fundCreatorAccess } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { isUniqueViolationOn } from "@/services/db/unique-violation";
import { claimWaiverCodeUse, findUsableWaiverCode } from "@/services/fund-setup/waiver-claim";
import { isSupportedLocale } from "@/services/i18n/config";
import { registerFundMcpResource } from "@/services/mcp/auth";
import { createFundRecord } from "./create";
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

// The claimed use must go back to the code when the fund can't be created:
// thrown inside the transaction so Prisma rolls it back.
class WaiverCodeUnusable extends Error {}

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

  // The gate accepts a holder of a usable waiver code besides admins and
  // staff; a code that came along is used either way (an admin's fund with a
  // code is waived too). It was checked when /new opened and is read again
  // here — it may have been used up, revoked or expired since — and claimed
  // inside the transaction below. Nothing tells those apart from a wrong
  // code (services/fund-setup/join.ts); a newcomer whose only key was that
  // code gets those words, not /unauthorized.
  const { user, access } = await fundCreatorAccess(parsed.data.code);
  if (!access) {
    if (parsed.data.code) return { error: t("join.errors.codeInvalid") };
    redirect("/unauthorized");
  }
  const waiverCode = parsed.data.code ? await findUsableWaiverCode(parsed.data.code) : null;
  if (parsed.data.code && !waiverCode) return { error: t("join.errors.codeInvalid") };

  // Inherit the creator's session locale as the fund's default. Most cases
  // the creator's locale matches the audience's; admin can change it later.
  const creatorLocale = await getLocale();
  const defaultLocale = isSupportedLocale(creatorLocale)
    ? creatorLocale
    : undefined; // schema default ("fr") if not supported
  const now = new Date();
  const record = {
    name: parsed.data.name,
    subdomain: parsed.data.subdomain,
    defaultLocale,
    ownerUserId: user.id,
    now,
  };

  let fund;
  try {
    fund = waiverCode
      ? await prisma.$transaction(async (tx) => {
          if (!(await claimWaiverCodeUse(tx, waiverCode, now))) throw new WaiverCodeUnusable();
          return createFundRecord(tx, {
            ...record,
            waiver: { codeId: waiverCode.id, label: waiverCode.label },
          });
        })
      : await createFundRecord(prisma, record);
  } catch (e) {
    if (e instanceof WaiverCodeUnusable) return { error: t("join.errors.codeInvalid") };
    if (isUniqueViolationOn(e, "domain")) {
      return {
        error: t("funds.create.errors.subdomainTaken"),
        field: "subdomain",
      };
    }
    throw e;
  }

  // The new host is an MCP OAuth resource from day one (best-effort).
  await registerFundMcpResource(fund);
  if (waiverCode) revalidatePath("/admin/waivers");
  return { ok: true, redirectTo: getFundUrl(fund.domain) };
}
