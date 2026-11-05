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

import {
  allowExistingAccountEmail,
  allowJoinSubmit,
  countJoinSubmit,
  lookupJoinCode,
  type JoinCodeLookup,
} from "./join";
import { sendJoinExistingAccountEmail } from "./join-emails";
import { JoinSchema, PASSWORD_MIN_LENGTH, type JoinInput } from "./schema";
import { claimWaiverCodeUse, findUsableWaiverCode } from "./waiver-claim";
import { formatWaiverCode } from "./waiver-codes";

// The apex /join submit (see ./join.ts for the door and its posture): one
// transaction creates the account (User + its credential Account, the two
// rows Better Auth's sign-up would write — its own sign-up stays disabled,
// review S5, like the member path in services/member/auth.ts) and creates
// the fund with that account as OWNER. With an invite code the same
// transaction first claims a use of it and the fund starts waived; any
// failure after the claim rolls the use back.

export type JoinField = "code" | "email" | "password" | "name" | "subdomain";

export type JoinResult =
  | { ok: true; redirectTo: string }
  // The address already has an account: the answer went to that inbox (the
  // sign-in link coming back to /new, with the code when there was one), the
  // screen only says an email went out — never which of the two happened to
  // which address.
  | { ok: true; sentTo: string }
  | { error: string; field?: JoinField };

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

/**
 * The form's check of a code typed into "I have an invite code" — the same
 * never-consuming lookup the page runs on ?code=, so the holder sees the
 * verdict (and the code's label) before creating anything.
 */
export async function checkJoinCodeAction(raw: string): Promise<JoinCodeLookup> {
  return lookupJoinCode(typeof raw === "string" ? raw : "");
}

export async function joinAction(input: JoinInput): Promise<JoinResult> {
  const t = await getTranslations();

  const parsed = JoinSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path[0] as JoinField | undefined;
    return {
      error: t(issue.message as never, (field ? FIELD_PARAMS[field] : {}) as never),
      field,
    };
  }
  const { code: normalisedCode, email, password, name, subdomain } = parsed.data;

  if (!(await allowJoinSubmit(normalisedCode ?? null))) return { error: t("join.errors.tooMany") };

  // A code that came along is read before anything is written; nothing
  // tells an unknown one from a dead one (join.ts). None is no gate.
  const code = normalisedCode ? await findUsableWaiverCode(normalisedCode) : null;
  if (normalisedCode && !code) {
    await countJoinSubmit();
    return { error: t("join.errors.codeInvalid"), field: "code" };
  }

  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(password);
  const creatorLocale = await getLocale();
  const defaultLocale = isSupportedLocale(creatorLocale) ? creatorLocale : undefined;
  const now = new Date();

  // The address is stored lowercase (the schema did that) like every account
  // — Better Auth lowercases on sign-in. No "does it exist" read first: the
  // unique index answers inside the transaction, and that answer leaves by
  // email (below), so the form never tells one address from another.
  let created: { userId: string; fund: { id: string; name: string; domain: string } };
  try {
    created = await prisma.$transaction(async (tx) => {
      if (code && !(await claimWaiverCodeUse(tx, code, now))) throw new WaiverCodeUnusable();
      // Nothing proved this inbox (the staff invite's token did), so the
      // account starts unverified; the verification email below, or a
      // password reset (services/auth/better-auth.ts::onPasswordReset),
      // verifies it.
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
        waiver: code ? { codeId: code.id, label: code.label } : undefined,
      });
      return { userId: user.id, fund: { id: fund.id, name: fund.name, domain: fund.domain } };
    });
  } catch (e) {
    // Each race has its own answer. The code's last use went to someone else:
    // same words as a wrong code. The address has an account: an email to
    // that inbox with the sign-in link that comes back to /new (the code
    // along, if any; one per address per while), and a screen that says
    // only that. The subdomain got taken: say so — that submit spends
    // nothing of the IP's budget.
    if (e instanceof WaiverCodeUnusable) {
      await countJoinSubmit();
      return { error: t("join.errors.codeInvalid"), field: "code" };
    }
    if (isUniqueViolationOn(e, "email")) {
      await countJoinSubmit();
      if (allowExistingAccountEmail(email)) {
        const newFundPath = code
          ? `/new?code=${encodeURIComponent(formatWaiverCode(code.code))}`
          : "/new";
        const signInUrl = getAuthUrl(
          `/login?return_to=${encodeURIComponent(getApexUrl(newFundPath))}`,
        );
        try {
          await sendJoinExistingAccountEmail({ email, signInUrl });
        } catch (err) {
          console.error("[join] existing-account email failed:", err);
        }
      }
      return { ok: true, sentTo: email };
    }
    if (isUniqueViolationOn(e, "domain")) {
      return { error: t("funds.create.errors.subdomainTaken"), field: "subdomain" };
    }
    throw e;
  }
  await countJoinSubmit();

  // The new host is an MCP OAuth resource from day one (best-effort inside).
  await registerFundMcpResource(created.fund);

  const dashboardUrl = `${getFundUrl(created.fund.domain)}/dashboard`;

  // Better Auth's verification email (emailVerification.sendVerificationEmail
  // in better-auth.ts): the link marks the account verified and comes back
  // to the dashboard, which offers to resend it until then. Best-effort
  // whatever failed (the endpoint, or the mail provider behind it): the
  // account and the fund exist, and a password reset verifies too.
  try {
    await auth.api.sendVerificationEmail({
      body: { email, callbackURL: dashboardUrl },
      headers: await headers(),
    });
  } catch (e) {
    console.error("[join] verification email failed:", isAPIError(e) ? e.body : e);
  }

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

  if (code) revalidatePath("/admin/waivers");
  // Cross-host handoff (services/auth/redirects.ts): a single-use code bound
  // to the fund's host, consumed by its /auth/exchange, which writes that
  // host's session cookie and lands them on the dashboard.
  const redirectTo = await buildPostAuthRedirect({
    userId: created.userId,
    email,
    returnTo: dashboardUrl,
  });
  return { ok: true, redirectTo };
}
