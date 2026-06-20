// SPDX-License-Identifier: AGPL-3.0-or-later
import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/services/auth/better-auth";
import { getCurrentUser } from "@/services/auth/dal";
import { assertReturnToAllowed } from "@/services/auth/redirects";
import { getApexUrl } from "@/services/fund/server";

// Sign out everywhere. Each host now owns its own session cookie (post-
// crossSubDomainCookies removal), so we have to invalidate ALL of the user's
// session rows — not just the local one — to actually log them out across
// every fund subdomain and the apex. The remote hosts' stale cookies will
// fail their next getSession() lookup against the DB and stop being trusted.
//
// GET is supported for nav-from-link convenience but POST is the preferred
// trigger — a POST form can't be triggered by a navigation prefetch.

export async function POST(request: NextRequest) {
  return handleLogout(request);
}

export async function GET(request: NextRequest) {
  return handleLogout(request);
}

async function handleLogout(request: NextRequest) {
  // Grab the user BEFORE signOut — once we sign out, getCurrentUser returns
  // null and we lose the userId we need to nuke all sessions.
  const user = await getCurrentUser();

  // signOut() invalidates the local session row + clears this host's cookie
  // via the nextCookies() plugin. Swallow errors — even if invalidation
  // fails we still want to redirect; the cookie clear-out usually still
  // happened.
  try {
    await auth.api.signOut({ headers: await headers() });
  } catch {
    // already-signed-out etc. — proceed to redirect anyway
  }

  // Wipe every other session row this user has on any host. Stale cookies
  // on those hosts will simply fail to resolve. No way to clear remote
  // cookies without bouncing through each host — and we don't have a list
  // of which hosts the user has visited anyway.
  if (user) {
    try {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(user.id);
    } catch (e) {
      console.error("logout: deleteSessions failed", e);
    }
  }

  const url = new URL(request.url);
  const rawReturnTo = url.searchParams.get("return_to");

  let final = getApexUrl("/");
  if (rawReturnTo) {
    try {
      await assertReturnToAllowed(rawReturnTo);
      final = rawReturnTo;
    } catch {
      // bad return_to → ignore, use apex default
    }
  }
  return NextResponse.redirect(final);
}
