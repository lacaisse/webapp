// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/services/db/prisma";
import { FundRole } from "@/services/db/generated/enums";
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

export const getCurrentUser = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
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

// =============================================================================
// Fund authorization
// =============================================================================

const FUND_ROLE_RANK: Record<FundRole, number> = {
  VIEWER: 0,
  ADMIN: 1,
  OWNER: 2,
};

function hasMinFundRole(actual: FundRole, minimum: FundRole) {
  return FUND_ROLE_RANK[actual] >= FUND_ROLE_RANK[minimum];
}

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
