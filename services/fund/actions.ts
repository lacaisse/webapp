// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getLocale, getTranslations } from "next-intl/server";
import { requireUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { isSupportedLocale } from "@/services/i18n/config";
import { generateFundMinter } from "@/services/token/minter";
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

  // Inherit the creator's session locale as the fund's default. Most cases
  // the creator's locale matches the audience's; admin can change it later.
  const creatorLocale = await getLocale();
  const defaultLocale = isSupportedLocale(creatorLocale)
    ? creatorLocale
    : undefined; // schema default ("fr") if not supported

  // Mint the per-fund token-minter keypair upfront so every fund has a
  // signing identity for UserOp-based mint/burn from day one — see
  // services/token/minter.ts. The smart-account address is derived later
  // (in services/citizenpay/connect.ts::consumeConnect) once CP returns
  // the per-treasury factory address.
  const minter = generateFundMinter();

  try {
    // One nested create. Default tier values come from the scoping doc's
    // example (5.3.1): min €100 / target €150 / max €225 — admin can edit
    // amounts and add more tiers from the settings UI.
    const fund = await prisma.fund.create({
      data: {
        name: parsed.data.name,
        domain,
        ...(defaultLocale ? { defaultLocale } : {}),
        tokenMinterPrivateKeyEnc: minter.privateKeyEnc,
        tokenMinterEoaAddress: minter.eoaAddress,
        staff: { create: { userId: user.id, role: "OWNER" } },
        tiers: {
          create: {
            name: "Standard",
            minContribution: "100.00",
            maxContribution: "225.00",
            allocationAmount: "150.00",
            position: 0,
          },
        },
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
