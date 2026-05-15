// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/services/db/prisma";
import { sendEmail } from "@/services/email/resend";

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

export const auth = betterAuth({
  baseURL: AUTH_HOST,
  database: prismaAdapter(prisma, { provider: "postgresql" }),

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
