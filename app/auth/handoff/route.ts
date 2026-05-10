import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdminClient } from "@/services/auth/admin";
import { createSupabaseServerClient } from "@/services/auth/server";
import { consumeExchangeCode } from "@/services/auth/exchange";

// Cross-host session establishment. The auth host (`auth.<APP_DOMAIN>`)
// authenticates the user, mints a single-use exchange code bound to the
// caller-requested target host, and redirects the browser here. We:
//
//   1. Atomically consume the code, asserting it was minted for THIS host.
//   2. Bridge into a Supabase session by minting a magic-link OTP server-side
//      and immediately verifying it via the SSR client — the response carries
//      the per-host session cookies.
//   3. Redirect to a safe `next` path on the same origin.
//
// This is the only place per-host Supabase cookies are written outside of a
// direct sign-in. The auth host never reaches this route.

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(new URL("/", url.origin));
  }

  const expectedHost = (request.headers.get("host") ?? "").split(":")[0];
  const result = await consumeExchangeCode({ code, expectedHost });
  if (!result) {
    // Expired / consumed / wrong host. Fail closed — back to home, the user
    // will be re-prompted to sign in by `requireUser`.
    return NextResponse.redirect(new URL("/", url.origin));
  }

  const admin = createSupabaseAdminClient();
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: result.email,
    });
  if (linkError || !linkData.properties?.email_otp) {
    return NextResponse.redirect(new URL("/", url.origin));
  }

  const supabase = await createSupabaseServerClient();
  const { error: otpError } = await supabase.auth.verifyOtp({
    email: result.email,
    token: linkData.properties.email_otp,
    type: "email",
  });
  if (otpError) {
    return NextResponse.redirect(new URL("/", url.origin));
  }

  // `next` is a relative path — resolve against the current origin to defend
  // against a crafted absolute URL sneaking in.
  const safeNext = next.startsWith("/") ? next : "/";
  return NextResponse.redirect(new URL(safeNext, url.origin));
}
