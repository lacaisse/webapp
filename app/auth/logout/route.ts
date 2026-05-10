import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/services/auth/server";
import { assertReturnToAllowed } from "@/services/auth/redirects";
import { getApexUrl } from "@/services/fund/server";
import { getAuthUrl, getHostType } from "@/services/host/server";

// Centralized logout. Triggered from a form POST anywhere in the app:
//
//   - On a fund/apex host: clear the local Supabase session, then bounce to
//     `auth.<APP_DOMAIN>/logout?return_to=<here>` so the auth-host session
//     is cleared too. Otherwise a follow-up request would silently re-auth.
//   - On the auth host: clear the auth-host session, then redirect to the
//     validated `return_to` (or the apex by default).
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
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  const url = new URL(request.url);
  const rawReturnTo = url.searchParams.get("return_to");
  const hostType = await getHostType();

  if (hostType !== "auth") {
    // Bounce through auth host so its session is cleared too. Pass our own
    // origin as return_to so we land back here when it's done.
    const localReturnTo = `${url.origin}/`;
    return NextResponse.redirect(
      getAuthUrl(
        `/logout?return_to=${encodeURIComponent(rawReturnTo ?? localReturnTo)}`,
      ),
    );
  }

  // We are the auth host — figure out where to send the user.
  let final = getApexUrl("/");
  if (rawReturnTo) {
    try {
      await assertReturnToAllowed(rawReturnTo);
      final = rawReturnTo;
    } catch {
      // Bad return_to → ignore and use the apex default.
    }
  }
  return NextResponse.redirect(final);
}
