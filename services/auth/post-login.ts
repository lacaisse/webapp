import "server-only";
import { issueExchangeCode } from "./exchange";
import { assertReturnToAllowed } from "./redirects";
import { getApexUrl } from "@/services/fund/server";

// Shared post-authentication step used by every successful login flow on the
// auth host (password, signup-with-immediate-session, passkey). Validates a
// caller-supplied `returnTo`, falls back to the apex, then mints a single-use
// exchange code bound to the target host and returns the URL to redirect the
// browser to. The target host's /auth/handoff route consumes the code and
// writes per-host Supabase cookies.

export type LoginRedirect = {
  url: string; // absolute, includes target origin + /auth/handoff?code=…&next=…
  origin: string;
  path: string;
};

export async function buildLoginRedirect(args: {
  userId: string;
  email: string;
  returnTo?: string | null;
}): Promise<LoginRedirect> {
  const apexOrigin = new URL(getApexUrl("/")).origin;
  let origin = apexOrigin;
  let path = "/";

  if (args.returnTo) {
    try {
      const allowed = await assertReturnToAllowed(args.returnTo);
      origin = allowed.origin;
      path = allowed.path || "/";
    } catch {
      // Fall through to apex default — never expose validation details to the
      // caller; a bad return_to just means "go home."
    }
  }

  const targetHost = new URL(origin).hostname;
  const code = await issueExchangeCode({
    userId: args.userId,
    email: args.email,
    targetHost,
  });

  const url = `${origin}/auth/handoff?code=${encodeURIComponent(code)}&next=${encodeURIComponent(path)}`;
  return { url, origin, path };
}
