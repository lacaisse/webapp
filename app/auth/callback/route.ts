import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/services/auth/server";

// Supabase PKCE callback. Recovery links from `resetPasswordForEmail` (and
// any future OAuth / magic-link flows) land here with `?code=...&next=/...`.
// We exchange the code for a session — `@supabase/ssr` writes the session
// cookies onto the response — then redirect to `next`.
//
// Always lives on the apex (the action that triggers it pins `redirectTo`
// to the apex via getApexUrl). If a request lands here with no code we
// bounce to /login.

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL("/login?error=auth_callback_failed", url.origin),
    );
  }

  // `next` is a relative path — resolve against the current origin to avoid
  // open-redirect risk if a crafted absolute URL ever sneaks in.
  const safeNext = next.startsWith("/") ? next : "/";
  return NextResponse.redirect(new URL(safeNext, url.origin));
}
