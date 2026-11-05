// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { isAPIError } from "better-auth/api";
import { getLocale, getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auth } from "@/services/auth/better-auth";
import { buildPostAuthRedirect } from "@/services/auth/redirects";
import { prisma } from "@/services/db/prisma";
import { isUniqueViolationOn } from "@/services/db/unique-violation";
import { createFundRecord } from "@/services/fund/create";
import { getApexUrl, getFundUrl } from "@/services/fund/host";
import {
  NAME_MIN_LENGTH,
  SUBDOMAIN_MAX_LENGTH,
  SUBDOMAIN_MIN_LENGTH,
} from "@/services/fund/schema";
import { getAuthUrl } from "@/services/host/server";
import { isSupportedLocale } from "@/services/i18n/config";
import { registerFundMcpResource } from "@/services/mcp/auth";

import { allowJoinSubmit } from "./join";
import { JoinWithCodeSchema, PASSWORD_MIN_LENGTH, type JoinWithCodeInput } from "./schema";
import { claimWaiverCodeUse, findUsableWaiverCode } from "./waiver-claim";
import { formatWaiverCode } from "./waiver-codes";

// The apex /join submit (see ./join.ts for the door and its posture): one
// transaction claims a use of the code, creates the account (User + its
// credential Account, the two rows Better Auth's sign-up would write — its
// own sign-up stays disabled, review S5, like the member path in
// services/member/auth.ts) and creates the fund with that account as OWNER,
// waived from the start. Any failure after the claim rolls the use back.

export type JoinField = "code" | "email" | "password" | "name" | "subdomain";

export type JoinWithCodeResult =
  | { ok: true; redirectTo: string }
  // `signInUrl` rides with the "account exists" answer: the auth host's login,
  // coming back to /new?code= where the gate accepts the same code, so the
  // person signs in first and then creates the fund on their existing account.
  | { error: string; field?: JoinField; signInUrl?: string };

class WaiverCodeUnusable extends Error {}

// The password constraints and the fund-field constraints share the {min}
// placeholder with different values, so each field interpolates its own.
const FIELD_PARAMS: Record<JoinField, Record<string, number>> = {
  code: {},
  email: {},
  password: { min: PASSWORD_MIN_LENGTH },
  name: { min: NAME_MIN_LENGTH },
  subdomain: { min: SUBDOMAIN_MIN_LENGTH, max: SUBDOMAIN_MAX_LENGTH },
};

export async function joinWithCodeAction(input: JoinWithCodeInput): Promise<JoinWithCodeResult> {
  const t = await getTranslations();

  const parsed = JoinWithCodeSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path[0] as JoinField | undefined;
    return {
      error: t(issue.message as never, (field ? FIELD_PARAMS[field] : {}) as never),
      field,
    };
  }
  const { code: normalisedCode, email, password, name, subdomain } = parsed.data;

  if (!(await allowJoinSubmit(normalisedCode))) return { error: t("join.errors.tooMany") };

  const code = await findUsableWaiverCode(normalisedCode);
  if (!code) return { error: t("join.errors.codeInvalid"), field: "code" };

  const signInUrl = getAuthUrl(
    `/login?return_to=${encodeURIComponent(
      getApexUrl(`/new?code=${encodeURIComponent(formatWaiverCode(code.code))}`),
    )}`,
  );

  // Better Auth lowercases on sign-in, so the address is stored lowercase (the
  // schema did that) and compared without case here, in case an older row
  // kept its capitals. A pre-check so the common case gets its answer without
  // a failed insert; the unique index stays the truth (the catch below).
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return { error: t("join.errors.accountExists"), field: "email", signInUrl };

  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(password);
  const creatorLocale = await getLocale();
  const defaultLocale = isSupportedLocale(creatorLocale) ? creatorLocale : undefined;
  const now = new Date();

  let created: { userId: string; fund: { id: string; name: string; domain: string } };
  try {
    created = await prisma.$transaction(async (tx) => {
      if (!(await claimWaiverCodeUse(tx, code, now))) throw new WaiverCodeUnusable();
      // Nothing proved this inbox (the staff invite's token did), so the
      // account starts unverified like a member login; a password reset
      // verifies it later (services/auth/better-auth.ts::onPasswordReset).
      const user = await tx.user.create({
        data: { email, name: email.split("@")[0] ?? "", emailVerified: false },
        select: { id: true },
      });
      await tx.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: passwordHash,
        },
      });
      const fund = await createFundRecord(tx, {
        name,
        subdomain,
        defaultLocale,
        ownerUserId: user.id,
        now,
        waiver: { codeId: code.id, label: code.label },
      });
      return { userId: user.id, fund: { id: fund.id, name: fund.name, domain: fund.domain } };
    });
  } catch (e) {
    // Each race has its own answer: the code's last use went to someone else
    // (same words as a wrong code); the address got an account meanwhile
    // (sign in instead); the subdomain got taken meanwhile.
    if (e instanceof WaiverCodeUnusable) return { error: t("join.errors.codeInvalid"), field: "code" };
    if (isUniqueViolationOn(e, "email")) {
      return { error: t("join.errors.accountExists"), field: "email", signInUrl };
    }
    if (isUniqueViolationOn(e, "domain")) {
      return { error: t("funds.create.errors.subdomainTaken"), field: "subdomain" };
    }
    throw e;
  }

  // The new host is an MCP OAuth resource from day one (best-effort inside).
  await registerFundMcpResource(created.fund);

  // Sign the new account in on this host (the apex) the way the auth host's
  // sign-up does, so the fund picker knows them next time: nextCookies writes
  // the session cookie on this action's response. Best-effort — the exchange
  // below carries the identity to the fund's own host regardless.
  try {
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch (e) {
    if (!isAPIError(e)) throw e;
    console.error("[join] sign-in after account creation failed:", e.body);
  }

  revalidatePath("/admin/waivers");
  // Cross-host handoff (services/auth/redirects.ts): a single-use code bound
  // to the fund's host, consumed by its /auth/exchange, which writes that
  // host's session cookie and lands them on the dashboard.
  const redirectTo = await buildPostAuthRedirect({
    userId: created.userId,
    email,
    returnTo: `${getFundUrl(created.fund.domain)}/dashboard`,
  });
  return { ok: true, redirectTo };
}
