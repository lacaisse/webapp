// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Step-up authentication proof (review finding S4). A session cookie alone
// is not enough to move a Safe's money or change its owners: the acting
// user must have re-entered their password or completed a passkey assertion
// within the last RECENT_AUTH_MAX_AGE_MS. That recent authentication is
// recorded as a small signed proof in a host-only cookie:
//
//   <base64url(json claims)>.<base64url(hmac-sha256(secret, claims))>
//
// The claims bind the proof to the user (`sub`), to the hash of the session
// token it was issued for (`sid`), and to the host it was issued on
// (`host`), with an issue time (`iat`). The server verifies all of them on
// every check — nothing in the cookie is trusted on its own, and a proof
// lifted from one session or host is useless with another. Only two places
// mint one: the password re-auth server action (services/auth/step-up-
// actions.ts) and the Better Auth after-hook on the passkey assertion
// endpoint (services/auth/better-auth.ts). This module is the pure part
// (no Next request context) so it can be unit-tested.

export const RECENT_AUTH_MAX_AGE_MS = 10 * 60 * 1000; // 10 min

// Clock skew we tolerate on `iat` (a proof "from the future" is rejected
// beyond this).
const MAX_FUTURE_SKEW_MS = 60 * 1000;

export type RecentAuthMethod = "password" | "passkey";

export type RecentAuthClaims = {
  v: 1;
  sub: string; // user id
  sid: string; // sessionRef(session token)
  host: string; // request host the proof was issued on
  iat: number; // ms since epoch
  method: RecentAuthMethod;
};

const COOKIE_BASE_NAME = "la-caisse.reauth";

/** Cookie name — `__Secure-` prefixed where cookies are Secure (prod). */
export function recentAuthCookieName(secure: boolean): string {
  return secure ? `__Secure-${COOKIE_BASE_NAME}` : COOKIE_BASE_NAME;
}

export function recentAuthCookieAttributes(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(RECENT_AUTH_MAX_AGE_MS / 1000),
  };
}

/** Opaque, non-reversible reference to a session token. */
export function sessionRef(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signRecentAuthProof(
  claims: Omit<RecentAuthClaims, "v">,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...claims })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * The cookie that records a re-authentication, ready for a cookie jar
 * (`cookies().set` in a Server Action, `ctx.setCookie` in a Better Auth
 * hook). `secure` selects the prod naming/attributes.
 */
export function buildRecentAuthCookie(
  args: { userId: string; sessionToken: string; host: string; method: RecentAuthMethod },
  secret: string,
  secure: boolean,
  now = Date.now(),
) {
  return {
    name: recentAuthCookieName(secure),
    value: signRecentAuthProof(
      {
        sub: args.userId,
        sid: sessionRef(args.sessionToken),
        host: args.host,
        iat: now,
        method: args.method,
      },
      secret,
    ),
    attributes: recentAuthCookieAttributes(secure),
  };
}

export type VerifyRecentAuthArgs = {
  secret: string;
  userId: string;
  sessionToken: string;
  host: string;
  now?: number;
  maxAgeMs?: number;
};

/**
 * The proof's claims when it is genuine, unexpired and bound to exactly
 * this user, session and host — otherwise null. Never throws.
 */
export function verifyRecentAuthProof(
  value: string | null | undefined,
  args: VerifyRecentAuthArgs,
): RecentAuthClaims | null {
  if (!value || !args.secret) return null;
  const sep = value.indexOf(".");
  if (sep <= 0) return null;
  const payload = value.slice(0, sep);
  const sig = value.slice(sep + 1);
  const expected = sign(payload, args.secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isClaims(claims)) return null;

  const now = args.now ?? Date.now();
  const maxAge = args.maxAgeMs ?? RECENT_AUTH_MAX_AGE_MS;
  if (claims.iat > now + MAX_FUTURE_SKEW_MS) return null;
  if (now - claims.iat > maxAge) return null;
  if (claims.sub !== args.userId) return null;
  if (claims.host !== args.host) return null;
  if (!safeEqualString(claims.sid, sessionRef(args.sessionToken))) return null;
  return claims;
}

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function isClaims(x: unknown): x is RecentAuthClaims {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.sub === "string" &&
    c.sub !== "" &&
    typeof c.sid === "string" &&
    typeof c.host === "string" &&
    typeof c.iat === "number" &&
    Number.isFinite(c.iat) &&
    (c.method === "password" || c.method === "passkey")
  );
}
