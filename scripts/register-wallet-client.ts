// SPDX-License-Identifier: AGPL-3.0-or-later
// Register (or refresh) the Citizen Pay wallet as an OAuth client of this La
// Caisse deployment, from the environment — the same thing the Better Auth
// before-hook does on the first /oauth2/authorize or /oauth2/token hit after
// a boot (services/member/wallet-client.ts). Run it to register ahead of the
// first login, or to check what the row would be.
//
//   WALLET_OAUTH_CLIENT_SECRET=… CITIZENPAY_API_AUDIENCE=https://api2.citizenpay.xyz \
//   DATABASE_URL='<prod-pooled>' npx tsx scripts/register-wallet-client.ts [--dry]
//
// Prints the client id, redirect URIs, audience and the secret's hash (never
// the secret). `--dry` prints without writing.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  WALLET_CLIENT_ID,
  walletAudienceResourceRow,
  walletClientConfigFromEnv,
  walletOauthClientRow,
  withoutIdentity,
} from "../services/auth/oauth-provider-config";
import { PrismaClient } from "../services/db/generated/client";

const DRY = process.argv.includes("--dry");

const cfg = walletClientConfigFromEnv();
if (!cfg) {
  console.error("WALLET_OAUTH_CLIENT_SECRET and CITIZENPAY_API_AUDIENCE are required.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const client = walletOauthClientRow(cfg);
const resource = walletAudienceResourceRow(cfg);
console.log({
  clientId: client.clientId,
  clientSecretHash: client.clientSecret,
  redirectUris: client.redirectUris,
  audience: resource.identifier,
  accessTokenTtl: resource.accessTokenTtl,
  skipConsent: client.skipConsent,
  requirePKCE: client.requirePKCE,
});
if (DRY) process.exit(0);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
prisma
  .$transaction([
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
  ])
  .then(() => console.log("registered"))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
