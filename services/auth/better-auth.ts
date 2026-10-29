// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/services/db/prisma";
import { sendEmail } from "@/services/email/resend";
import { MCP_SCOPES, mcpResourceForOrigin } from "@/services/mcp/resource";

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

  emailAndPassword: {
    enabled: true,
    // Verification gated off — flip to true and add `sendVerificationEmail`
    // when product wants it. Today's flow signs the user in immediately
    // after sign-up.
    requireEmailVerification: false,
    minPasswordLength: 8,

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

  plugins: [
    // Signs the OAuth access tokens (and serves /api/auth/jwks, which the
    // MCP route verifies against). Required by @better-auth/mcp. The header
    // option stops it from also stamping a JWT on every session response.
    jwt({ disableSettingJwtHeader: true }),

    // OAuth 2.1 authorization server for MCP clients (agents operating the
    // dashboard through /api/mcp) — @better-auth/mcp on top of the OAuth
    // provider plugin. Clients self-register via dynamic client registration
    // (the open, unauthenticated kind: MCP clients have no credentials
    // before they register), PKCE is mandatory for them, and the user
    // authorizes on THIS host: the plugin sends the browser to /login with
    // a signed copy of the authorize query, the login action hands it back
    // as `oauth_query` (see app/(auth-host)/actions.ts), then /consent asks
    // for the grant. Tokens are deliberately short-lived: access tokens last
    // an hour and refresh tokens a day, so an agent's authorization decays
    // quickly unless the user re-approves.
    mcp({
      loginPage: "/login",
      consentPage: "/consent",
      resource: MCP_RESOURCE,
      // Prisma can't store a resource without allowedScopes (null list).
      resources: [{ identifier: MCP_RESOURCE, allowedScopes: MCP_SCOPES }],
      scopes: MCP_SCOPES,
      enforcePerClientResources: false,
      accessTokenExpiresIn: 60 * 60, // 1 h — the "short session"
      refreshTokenExpiresIn: 60 * 60 * 24, // 1 day, then re-authorize
      codeExpiresIn: 600,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Cursor / older Claude Code omit application_type; their loopback
      // redirect URIs make them native clients, not web ones.
      clientRegistrationDefaultApplicationType: "infer",
    }),
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
