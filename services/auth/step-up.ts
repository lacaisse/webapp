// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cookies, headers } from "next/headers";
import { auth } from "./better-auth";
import { getCurrentSession } from "./dal";
import {
  RECENT_AUTH_MAX_AGE_MS,
  buildRecentAuthCookie,
  recentAuthCookieName,
  verifyRecentAuthProof,
  type RecentAuthMethod,
} from "./recent-auth";

// Step-up authentication, request side (the pure proof lives in
// ./recent-auth.ts). Sensitive server actions — the Safe proposals and
// signatures, the manual mint/burn on /token — call `hasRecentAuth()` after
// their role and input checks and answer `reauth_required` when it is false
// (services/auth/step-up-types.ts); the client then opens the re-auth dialog
// (components/reauth-dialog.tsx) and retries.

const isProd = process.env.NODE_ENV === "production";

/** The host the current request was addressed to, as the proof binds it. */
async function currentHost(): Promise<string> {
  return (await headers()).get("host") ?? "";
}

/**
 * True when the signed-in user re-authenticated (password or passkey) on
 * this host, in this session, within `maxAgeMs` (default 10 minutes).
 */
export async function hasRecentAuth(maxAgeMs = RECENT_AUTH_MAX_AGE_MS): Promise<boolean> {
  const session = await getCurrentSession();
  if (!session) return false;
  const jar = await cookies();
  const value = jar.get(recentAuthCookieName(isProd))?.value;
  const { secret } = await auth.$context;
  return (
    verifyRecentAuthProof(value, {
      secret,
      userId: session.user.id,
      sessionToken: session.session.token,
      host: await currentHost(),
      maxAgeMs,
    }) !== null
  );
}

/**
 * Record a re-authentication for the current session, from a Server
 * Action (the cookie rides on the action's response). The caller has
 * verified the credential; this only mints the proof.
 */
export async function issueRecentAuthProof(args: {
  userId: string;
  sessionToken: string;
  method: RecentAuthMethod;
}): Promise<void> {
  const { secret } = await auth.$context;
  const cookie = buildRecentAuthCookie({ ...args, host: await currentHost() }, secret, isProd);
  (await cookies()).set(cookie.name, cookie.value, cookie.attributes);
}
