import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/services/db/prisma";
import { FundRole } from "@/services/db/generated/enums";
import { requireCurrentFund } from "@/services/fund/server";
import { getAuthUrl, getHostType } from "@/services/host/server";
import { createSupabaseServerClient } from "./server";

// =============================================================================
// Current user (Supabase auth ↔ Prisma User)
// =============================================================================
// `getCurrentUser` is the single source of truth for "who is the request from".
// It does just-in-time sync from Supabase auth.users into our Prisma User table
// so the rest of the app can speak in terms of Prisma rows (with globalRole,
// memberships, etc.) without caring about Supabase JWT internals.

export const getCurrentUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser?.email) return null;

  // Upsert is idempotent and one round-trip; React.cache memoizes per render.
  return prisma.user.upsert({
    where: { id: authUser.id },
    create: {
      id: authUser.id,
      email: authUser.email,
      name:
        (authUser.user_metadata?.full_name as string | undefined) ??
        (authUser.user_metadata?.name as string | undefined) ??
        null,
    },
    update: {
      email: authUser.email,
    },
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
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
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
