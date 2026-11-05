// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/services/db/prisma";
import { FundRole } from "@/services/db/generated/enums";
import { hasMinFundRole } from "@/services/auth/roles";
import { findUsableWaiverCode } from "@/services/fund-setup/waiver-claim";
import { requireCurrentFund } from "@/services/fund/server";
import { getAuthUrl, getHostType } from "@/services/host/server";
import { auth } from "./better-auth";

// =============================================================================
// Current user
// =============================================================================
// Better Auth owns the User table directly — there's no JIT sync to do. The
// session row points at our User row; we still fetch the full Prisma User
// here because callers need globalRole + relations that Better Auth's
// session.user shape doesn't include.

// The Better Auth session of the request (user + session row), cached per
// request. Step-up (services/auth/step-up.ts) binds its proof to
// `session.session.token`; everything else wants the Prisma user below.
export const getCurrentSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export const getCurrentUser = cache(async () => {
  const session = await getCurrentSession();
  if (!session?.user) return null;

  return prisma.user.findUnique({
    where: { id: session.user.id },
  });
});

export const requireUser = cache(async () => {
  const user = await getCurrentUser();
  if (!user) redirect(await loginUrlForCurrentRequest());
  return user;
});

async function loginUrlForCurrentRequest(): Promise<string> {
  const hostType = await getHostType();
  // On the auth host, /login is local — no return_to needed (the user is
  // already there). On apex/fund hosts, build an absolute return_to so the
  // post-login handoff can land them back where they were.
  if (hostType === "auth") return "/login";

  const h = await headers();
  const host = h.get("host");
  const path = h.get("x-pathname") ?? "/";
  const search = h.get("x-search") ?? "";
  if (!host) return getAuthUrl("/login");

  const proto = process.env.NODE_ENV === "production" ? "https" : "http";
  const returnTo = `${proto}://${host}${path}${search}`;
  return getAuthUrl(`/login?return_to=${encodeURIComponent(returnTo)}`);
}

export const requireAdmin = cache(async () => {
  const user = await requireUser();
  if (user.globalRole !== "ADMIN") redirect("/unauthorized");
  return user;
});

/**
 * Who may create a fund: a platform admin; a user who is already staff of
 * some fund (every staff account comes from an invite); or, on /new?code=,
 * the holder of a usable subscription waiver code (services/fund-setup/
 * waiver-claim.ts) — the code is admin-minted, limited and expiring, so
 * holding it is the invite, and createFundAction then claims a use and
 * creates the fund waived in one transaction. A card holder's member login
 * is a plain User too (services/member/auth.ts) and must not be able to
 * open a fund of its own and become its OWNER without one — it has no
 * FundMember row anywhere, so it is refused here.
 */
export const requireFundCreator = cache(async (waiverCode?: string) => {
  const user = await requireUser();
  if (user.globalRole === "ADMIN") return user;
  const staffRows = await prisma.fundMember.count({ where: { userId: user.id } });
  if (staffRows > 0) return user;
  if (waiverCode && (await findUsableWaiverCode(waiverCode))) return user;
  redirect("/unauthorized");
});

// =============================================================================
// Fund authorization
// =============================================================================

/**
 * Require the current user to be a member of the current fund (caisse) with
 * at least `minRole`. Redirects to /unauthorized if not. Returns user, fund,
 * and the membership row so callers don't re-query.
 */
export async function requireFundRole(minRole: FundRole) {
  const [user, fund] = await Promise.all([
    requireUser(),
    requireCurrentFund(),
  ]);
  const membership = await prisma.fundMember.findUnique({
    where: { userId_fundId: { userId: user.id, fundId: fund.id } },
  });
  if (!membership || !hasMinFundRole(membership.role, minRole)) {
    redirect("/unauthorized");
  }
  return { user, fund, membership };
}

// =============================================================================
// Member authorization (plan "Bread card-holder voting", PR W-1)
// =============================================================================
// A card holder's login is a plain `User` linked to one `Member` per fund
// through `Member.userId`. It is NOT staff: a member has no `FundMember` row,
// so `requireFundRole` (and with it the whole `(fund)` dashboard) never
// accepts a member session — services/auth/dal.member.test.ts pins that.
// Member pages gate on the two things below instead: the fund opted in
// (`Fund.memberLoginEnabled`, else 404 like every member route) and the
// signed-in user is a member of THIS fund.

/** The current user's Member row at the current fund, or null. */
export const getCurrentMember = cache(async () => {
  const [user, fund] = await Promise.all([getCurrentUser(), requireCurrentFund()]);
  if (!fund.memberLoginEnabled) notFound();
  if (!user) return { user: null, fund, member: null };
  const member = await prisma.member.findFirst({
    where: { fundId: fund.id, userId: user.id },
  });
  return { user, fund, member };
});

/**
 * Require a signed-in member of the current fund. Anonymous → the fund's
 * member /login (with a return path); signed in but not a member here →
 * /login too, which explains it. 404 when the fund has member login off.
 */
export async function requireMember() {
  const { user, fund, member } = await getCurrentMember();
  if (!user) {
    const h = await headers();
    const path = h.get("x-pathname") ?? "/account";
    const search = h.get("x-search") ?? "";
    redirect(`/login?return_to=${encodeURIComponent(`${path}${search}`)}`);
  }
  if (!member) redirect("/login?notice=no_membership");
  return { user, fund, member };
}
