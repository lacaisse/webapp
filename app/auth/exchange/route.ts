import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/services/auth/better-auth";
import { consumeExchangeCode } from "@/services/auth/exchange";
import { getApexUrl } from "@/services/fund/server";
import { getHostType } from "@/services/host/server";

// Single-use session bridge from `auth.<APP_DOMAIN>` to any other host. The
// auth host mints an `AuthExchange` code bound to (userId, targetHost) and
// redirects the browser to `<target>/auth/exchange?code=…&return_to=…`. This
// handler runs on the target host:
//
//   1. consumes the code (atomic single-use) — verifies it's bound to *this*
//      host so a code minted for fundA can't be replayed against fundB
//   2. creates a fresh Better Auth session row for the user
//   3. signs and writes the `better-auth.session_token` cookie as host-only
//      on this host (no Domain attribute) — that's the whole point: avoid
//      crossSubDomainCookies, which break under 3rd-party-cookie blocking
//      and don't span paid custom domains
//   4. redirects to the safe `return_to` path on this host (or `/`)
//
// All four steps must succeed; on any failure we redirect to the apex with
// `?error=exchange` so the UI can show a friendly message rather than 500.

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawReturnTo = url.searchParams.get("return_to");

  if (!code) return errorRedirect("missing-code");

  // Never exchange on the auth host itself — that's the source, not a target.
  // proxy.ts classifies it as `auth`; defence-in-depth in case something else
  // mounts this route.
  const hostType = await getHostType();
  if (hostType === "auth") return errorRedirect("invalid-target");

  // Match against the host the browser asked for, not the configured apex.
  // In dev that's `localhost` or `<sub>.localhost`; in prod it's the canonical
  // production host (or a custom domain). consumeExchangeCode requires an
  // exact match against the issuing host.
  const reqHost = (request.headers.get("host") ?? "").split(":")[0];
  if (!reqHost) return errorRedirect("missing-host");

  const exchanged = await consumeExchangeCode({
    code,
    expectedHost: reqHost,
  });
  if (!exchanged) return errorRedirect("invalid-code");

  // internalAdapter.createSession does the same DB write that signInEmail
  // does — but it's the only public-ish way to mint a session without a
  // credential check (which we don't need: the exchange code already proves
  // identity). Re-using `auth.$context` keeps us on the same Prisma adapter
  // and respects `generateId: "uuid"`.
  const ctx = await auth.$context;
  let session;
  try {
    session = await ctx.internalAdapter.createSession(exchanged.userId, false);
  } catch {
    return errorRedirect("session-create-failed");
  }
  if (!session) return errorRedirect("session-create-failed");

  // Only allow same-host relative paths from return_to. An absolute URL or a
  // path with a scheme is rejected — we always stay on the host that just
  // received the exchange. The browser already navigated here; cross-host
  // redirects would require another exchange round-trip.
  const safePath = sanitizePath(rawReturnTo);
  const dest = new URL(safePath, request.url);
  const res = NextResponse.redirect(dest);

  // Set cookies on the redirect response *itself*, not via `cookies()`. In a
  // Route Handler that returns a freshly-constructed NextResponse, the
  // cookies staged on the request-scoped `cookies()` jar do NOT travel into
  // that new response — they'd just disappear. Using `res.cookies.set` is
  // the only reliable path for auth bridges that redirect.
  writeSessionCookie(res, session.token, ctx);
  return res;
}

function writeSessionCookie(
  res: NextResponse,
  token: string,
  ctx: Awaited<typeof auth.$context>,
) {
  // Better Auth signs the session cookie with HMAC-SHA256 over the token and
  // serialises it as `${token}.${base64(sig)}`. See
  // better-call/dist/crypto.mjs:signCookieValue. We DELIBERATELY do not
  // URL-encode here: `NextResponse.cookies.set` percent-encodes the value
  // on its own, and pre-encoding would double-encode the `/` and `=` in the
  // base64 signature (→ `%252F`, `%253D`). Better Auth's parseCookies only
  // decodes once, so a double-encoded cookie fails signature verification
  // and getSession() returns null even though the token is correct.
  const sig = createHmac("sha256", ctx.secret).update(token).digest("base64");
  const value = `${token}.${sig}`;

  // Match the attributes Better Auth would have used — minus `domain`, which
  // we intentionally omit to keep the cookie host-only. `name` includes the
  // `__Secure-` prefix when running on HTTPS, so read it dynamically rather
  // than hardcoding.
  const { name, attributes } = ctx.authCookies.sessionToken;
  res.cookies.set({
    name,
    value,
    httpOnly: true,
    sameSite: attributes.sameSite as "lax",
    secure: !!attributes.secure,
    path: "/",
    maxAge: ctx.sessionConfig.expiresIn,
  });
}

function sanitizePath(rawReturnTo: string | null): string {
  if (!rawReturnTo) return "/";
  // Reject anything that could redirect off-host. `//foo.example/x` is a
  // protocol-relative URL and must be blocked too.
  if (!rawReturnTo.startsWith("/") || rawReturnTo.startsWith("//")) return "/";
  return rawReturnTo;
}

function errorRedirect(reason: string) {
  // Bounce to apex with a query param so the UI can render a translatable
  // error. We don't try to be clever and stay on the current host — that may
  // itself be inaccessible to the user (e.g. they're not a member of the
  // fund) and the apex is the universal fallback.
  const url = new URL(getApexUrl("/"));
  url.searchParams.set("auth_error", reason);
  return NextResponse.redirect(url);
}
