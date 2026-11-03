// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  WALLET_CLIENT_ID,
  walletAudienceResourceRow,
  walletClientConfigFromEnv,
  walletOauthClientRow,
  withoutIdentity,
} from "@/services/auth/oauth-provider-config";
import { prisma } from "@/services/db/prisma";

// Registration of the card wallet as a static, confidential OAuth client
// (services/auth/oauth-provider-config.ts has the shape and the reasons).
// The provider has no "trusted clients" option and its admin create endpoint
// generates the secret itself, so the row is written here from the
// environment: the wallet and this app share WALLET_OAUTH_CLIENT_SECRET, the
// row holds its SHA-256 (how the plugin stores hashed secrets), and a
// rotated env value re-hashes the row on the next boot. The api's audience
// is registered as an OauthResource at the same time, or authorize would
// refuse it with `invalid_target`.
//
// Runs once per process, lazily, from the Better Auth before-hook on
// /oauth2/authorize and /oauth2/token (the first OAuth hit after a deploy
// registers or refreshes it), and from `scripts/register-wallet-client.ts`
// for an explicit run. Idempotent.

let ensured: Promise<"registered" | "unconfigured"> | null = null;

export function ensureWalletOauthClient(): Promise<"registered" | "unconfigured"> {
  ensured ??= registerWalletOauthClient().catch((e) => {
    // Let the next request retry rather than caching a failure.
    ensured = null;
    throw e;
  });
  return ensured;
}

/** Write (or refresh) the wallet client and the api resource rows now. */
export async function registerWalletOauthClient(): Promise<"registered" | "unconfigured"> {
  const cfg = walletClientConfigFromEnv();
  if (!cfg) {
    console.warn(
      "[member-login] wallet OAuth client not configured (WALLET_OAUTH_CLIENT_SECRET / CITIZENPAY_API_AUDIENCE) — the wallet cannot log members in",
    );
    return "unconfigured";
  }
  const now = new Date();
  const client = walletOauthClientRow(cfg, now);
  const resource = walletAudienceResourceRow(cfg, now);
  await prisma.$transaction([
    prisma.oauthClient.upsert({
      where: { clientId: WALLET_CLIENT_ID },
      create: client,
      update: withoutIdentity(client, ["createdAt", "clientId"]),
    }),
    prisma.oauthResource.upsert({
      where: { identifier: cfg.audience },
      create: resource,
      update: withoutIdentity(resource, ["createdAt", "identifier"]),
    }),
  ]);
  return "registered";
}
