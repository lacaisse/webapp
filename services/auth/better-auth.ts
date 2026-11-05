// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/services/db/prisma";
import { sendEmail } from "@/services/email/resend";
import { mcpResourceForOrigin } from "@/services/mcp/resource";
import {
  clientIdFromTokenRequest,
  oauthProviderOptions,
  resourceAllowedForClient,
  walletClientConfigFromEnv,
} from "@/services/auth/oauth-provider-config";
import { buildRecentAuthCookie } from "@/services/auth/recent-auth";
import { ensureWalletOauthClient } from "@/services/member/wallet-client";

// Better Auth replaces Supabase Auth as the identity layer. Postgres stays —
// Supabase is only the host; queries still go through Prisma. Each host gets
// its OWN session cookie (no crossSubDomainCookies). After auth on
// `auth.<APP_DOMAIN>`, the user is redirected to a target host via a single-
// use exchange code (`services/auth/exchange.ts` + `app/auth/exchange/`),
// which mints a fresh session and writes the cookie on that host. This is
// the Google-style handoff — works the same for free funds, paid custom
// domains, and users who disable third-party cookies in the browser.

const APP_DOMAIN = process.env.APP_DOMAIN ?? "localhost";
const isProd = process.env.NODE_ENV === "production";

// Auth host URL — the canonical origin Better Auth signs cookies for. Must
// match what proxy.ts classifies as host=auth. Used to compose reset-password
// / verify email links and as the trusted-origin baseline.
const AUTH_HOST = isProd
  ? `https://auth.${APP_DOMAIN}`
  : `http://auth.${APP_DOMAIN}:${process.env.PORT ?? 3000}`;

// The auth handler is mounted at /api/auth on EVERY host (apex, auth, fund
// subdomains, paid custom domains). Server actions (`auth.api.*`, e.g.
// login/signup) carry no Origin header so they skip Better Auth's CSRF origin
// check — but browser-driven flows like the passkey ceremony POST to the
// current origin and DO get checked. trustedOrigins defaults to only the
// baseURL (the auth host), so a passkey registration on `localhost:3000` (or
// `acme.lacaisse.eu`) is rejected with "Invalid origin". List every host we
// serve. Patterns: `*.<APP_DOMAIN>` covers the auth host + all free fund
// subdomains; the apex needs its own entry (the wildcard requires a label).
const APP_SCHEME = isProd ? "https" : "http";
const PORT_SUFFIX = isProd ? "" : `:${process.env.PORT ?? 3000}`;
const APEX_ORIGIN = `${APP_SCHEME}://${APP_DOMAIN}${PORT_SUFFIX}`;
const WILDCARD_ORIGIN = `${APP_SCHEME}://*.${APP_DOMAIN}${PORT_SUFFIX}`;

// The MCP server as an OAuth protected resource. The plugin wants ONE
// canonical resource: that's the apex's `/api/mcp`, seeded into OauthResource
// at boot. Fund hosts (`https://<fund-domain>/api/mcp`) are resources too —
// registered on first discovery by services/mcp/auth.ts, which is also where
// tokens are verified per host. `enforcePerClientResources` is therefore off:
// any registered client may target any enabled resource row.
const MCP_RESOURCE = mcpResourceForOrigin(APEX_ORIGIN);

// Whether a session needs a verified email (Better Auth's
// `requireEmailVerification`). Exported for the invite rule, which is moot
// once this is on.
export const REQUIRE_EMAIL_VERIFICATION = false;

export const auth = betterAuth({
  baseURL: AUTH_HOST,
  database: prismaAdapter(prisma, { provider: "postgresql" }),

  // The jwt plugin's bare `/token` endpoint would mint session-backed JWTs
  // outside OAuth; the provider's `/oauth2/token` is the only token door.
  disabledPaths: ["/token"],

  // Merged with the default (baseURL) list. A function so paid custom domains —
  // which aren't subdomains of APP_DOMAIN and so escape the wildcard — can be
  // trusted per-request: proxy.ts already validated the host against
  // `Fund.domain` and stamped a (spoof-proof) `x-fund-domain` header, so if the
  // request rode in on a custom domain we trust exactly that origin.
  trustedOrigins: async (request) => {
    const origins = [APEX_ORIGIN, WILDCARD_ORIGIN];
    const fundDomain = request?.headers.get("x-fund-domain");
    if (
      fundDomain &&
      fundDomain !== APP_DOMAIN &&
      !fundDomain.endsWith(`.${APP_DOMAIN}`)
    ) {
      origins.push(`${APP_SCHEME}://${fundDomain}${PORT_SUFFIX}`);
    }
    return origins;
  },

  advanced: {
    // UUIDs at the app layer — keeps User.id @db.Uuid and all existing
    // userId FK columns (FundMember, Member, Merchant.reviewerId, etc.)
    // untouched. crypto.randomUUID() is invoked on every insert.
    database: { generateId: "uuid" },

    // Default cookie attributes — host-only (no Domain), SameSite=Lax. Each
    // host owns its session cookie; cross-host handoff goes through
    // /auth/exchange. Don't add crossSubDomainCookies here: it would break
    // the handoff flow and revive the third-party-cookie problem.
  },

  // The verification email itself exists (below) — the apex /join door sends
  // one to the account it creates, and the dashboard can resend it — but a
  // session does not yet NEED a verified email: `requireEmailVerification`
  // stays off. It is also read by the invite rule in
  // services/fund-team/invite-rules.ts; keep REQUIRE_EMAIL_VERIFICATION
  // above in step when flipping it.
  emailVerification: {
    // `url` is `${AUTH_HOST}/api/auth/verify-email?token=…&callbackURL=…`:
    // the route marks the account verified and sends the browser on to the
    // callback (origin-checked against trustedOrigins). Same lazy i18n as
    // the reset email.
    sendVerificationEmail: async ({ user, url }) => {
      const t = await getTranslations("auth.emails.verifyEmail");
      const text = t("text", { email: user.email, url });
      await sendEmail({
        to: user.email,
        subject: t("subject"),
        text,
        html: `<p>${text.replace(/\n/g, "</p><p>")}</p>`,
      });
    },
    // A day, like the member-login verification: long enough to find the
    // email the next morning.
    expiresIn: 24 * 60 * 60,
  },

  emailAndPassword: {
    enabled: true,
    // Today's flows sign the user in immediately after account creation.
    requireEmailVerification: REQUIRE_EMAIL_VERIFICATION,
    minPasswordLength: 8,
    // The public `/api/auth/sign-up/email` is closed on every host (review
    // S5: anyone could register a colleague's address ahead of their invite
    // and share the account). Accounts are created only by the sign-up
    // server action, bound to a live invite for that exact email
    // (services/auth/signup.ts). Sign-in is unaffected, and so is the MCP
    // OAuth login resume, which rides on sign-in.
    disableSignUp: true,
    // A password reset signs the user out everywhere: the reset is the
    // recovery path for a compromised or pre-registered account, and an
    // attacker's live sessions must not outlive it.
    revokeSessionsOnPasswordReset: true,
    // The reset link reached the inbox, so the resetting user controls the
    // email: mark it verified (that is what the invite rule asks of an
    // account that predates its invite). If nobody had verified it before,
    // any passkey on it is of unknown provenance — the account may have
    // been registered by someone else — so those are dropped too; a
    // verified account keeps its passkeys as a normal reset would.
    onPasswordReset: async ({ user }) => {
      if (user.emailVerified) return;
      await prisma.$transaction([
        prisma.passkey.deleteMany({ where: { userId: user.id } }),
        prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } }),
      ]);
    },

    sendResetPassword: async ({ user, url }) => {
      // url is `${AUTH_HOST}/reset-password?token=…` (callbackURL passed
      // by the forgot-password action). i18n key + lazy import keep this
      // module free of next-intl context surprises.
      const t = await getTranslations("auth.emails.resetPassword");
      const text = t("text", { url });
      await sendEmail({
        to: user.email,
        subject: t("subject"),
        text,
        html: `<p>${text.replace(/\n/g, "</p><p>")}</p>`,
      });
    },
  },

  hooks: {
    // The card wallet's OAuth client is a static row written from the
    // environment (services/member/wallet-client.ts). Make sure it exists —
    // once per process — before the provider looks it up, so a fresh deploy
    // or a rotated secret needs no migration step.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/oauth2/authorize" && ctx.path !== "/oauth2/token") return;
      await ensureWalletOauthClient();
      // The api audience is the wallet's alone (see resourceAllowedForClient):
      // refused before the provider looks at the request. The token endpoint
      // is covered for a refresh or exchange that names the api outright;
      // a code only ever carries resources the authorize step allowed.
      const audience = walletClientConfigFromEnv()?.audience;
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const query = (ctx.query ?? {}) as Record<string, unknown>;
      const clientId =
        ctx.path === "/oauth2/authorize"
          ? ((query.client_id ?? body.client_id) as string | undefined)
          : clientIdFromTokenRequest(body, ctx.request?.headers.get("authorization"));
      const resource = ctx.path === "/oauth2/authorize" ? (query.resource ?? body.resource) : body.resource;
      if (!resourceAllowedForClient(clientId, resource, audience)) {
        throw new APIError("BAD_REQUEST", {
          error: "invalid_target",
          error_description: "this resource is reserved for the Citizen Pay wallet client",
        });
      }
    }),

    // Step-up by passkey (review S4). The plugin's assertion endpoint
    // creates a new session for the passkey's user on this host; when it
    // did, also record that authentication as a step-up proof bound to
    // that new session — the Safe actions check it (services/auth/step-
    // up.ts). A user who re-asserts their own passkey keeps working as
    // themselves with a fresh proof; the password path has its own action.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/passkey/verify-authentication") return;
      const fresh = ctx.context.newSession;
      if (!fresh) return;
      const cookie = buildRecentAuthCookie(
        {
          userId: fresh.user.id,
          sessionToken: fresh.session.token,
          host: ctx.headers?.get("host") ?? "",
          method: "passkey",
        },
        ctx.context.secret,
        isProd,
      );
      ctx.setCookie(cookie.name, cookie.value, cookie.attributes);
    }),
  },

  plugins: [
    // Signs the OAuth access tokens (and serves /api/auth/jwks, which the
    // MCP route verifies against). Required by @better-auth/mcp. The header
    // option stops it from also stamping a JWT on every session response.
    jwt({ disableSettingJwtHeader: true }),

    // OAuth 2.1 authorization server — @better-auth/mcp on top of the OAuth
    // provider plugin — for two kinds of clients. MCP agents operating the
    // dashboard through /api/mcp self-register via dynamic client
    // registration (the open, unauthenticated kind: MCP clients have no
    // credentials before they register), PKCE is mandatory for them, and
    // the user authorizes on THIS host: the plugin sends the browser to
    // /login with a signed copy of the authorize query, the login action
    // hands it back as `oauth_query` (see app/(auth-host)/actions.ts), then
    // /consent asks for the grant; their tokens stay short-lived (1 h access,
    // 1 day refresh through the per-resource TTL). The Citizen Pay card
    // wallet is a static first-party client that logs fund MEMBERS in
    // (consent skipped, 15 min access tokens bound to the api's audience,
    // 30 day rotating refresh tokens) — services/auth/oauth-provider-config.ts
    // holds the options and the token contract, services/member/wallet-
    // client.ts the registration.
    mcp(oauthProviderOptions({ mcpResource: MCP_RESOURCE })),
    passkey({
      rpName: "La Caisse",
      // rpID = apex, so a passkey registered on acme.lacaisse.eu works
      // across every fund subdomain. In dev this is "localhost".
      rpID: APP_DOMAIN,
      // origin omitted — the plugin accepts the request origin as long as
      // it's a subdomain of rpID, which matches our multi-tenant scope.
    }),
    nextCookies(), // must be last — auto-sets cookies on Server Action responses
  ],
});

export type Session = typeof auth.$Infer.Session;
