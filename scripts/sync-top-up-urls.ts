// SPDX-License-Identifier: AGPL-3.0-or-later
// One-off: publish every connected fund's top-up URL to its CitizenPay
// treasury (the public card wallet's "Add funds" link — see
// services/citizenpay/top-up-url.ts). The app syncs it on its own from now on
// (general settings save + CP connect pickup, via
// services/citizenpay/sync-top-up-url.ts); this catches funds connected
// before that existed. Idempotent — safe to re-run.
//
// Usage (against prod — NODE_ENV=production makes the URLs https without a
// port, exactly as the deployed app builds them):
//
//   npx prisma generate
//   NODE_ENV=production APP_DOMAIN=lacaisse.eu \
//   DATABASE_URL='<prod-pooled>' APP_CRED_KEY=<hex> \
//   CITIZENPAY_API_BASE_URL=<cp-base-url> \
//     npx tsx scripts/sync-top-up-urls.ts            # dry run: prints the plan
//     npx tsx scripts/sync-top-up-urls.ts --apply    # writes it
//
// Dry run is the default. `--apply` refuses to write anything unless every
// computed URL is https (forgetting NODE_ENV/APP_DOMAIN would otherwise push
// `http://…:3000` or `*.localhost` links to real treasuries).
//
// DISABLED funds compute "no link", but the run only clears a link La Caisse
// published itself (the fund's own /pay/{serial}): it reads the treasury's
// current `top_up_url` first and leaves anything else — e.g. Brussels Pay's
// CP checkout — in place, printed as "(leave: CP-managed URL)". The dry run
// does that read too when APP_CRED_KEY + CITIZENPAY_API_BASE_URL are set.
// Logic lives in scripts/lib/top-up-url-sync.ts.
//
// The service layer (client factory, api.ts, crypto/secret.ts, db/prisma.ts)
// is `server-only` and won't load outside Next.js, so — like the other
// scripts — this builds its own PrismaClient and inlines the decrypt + the
// GET / PATCH. Only the pure URL rules are shared with the app.

import "dotenv/config";
import { createDecipheriv } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";
import { isPublishableTopUpUrl } from "../services/citizenpay/top-up-url";

import { probeTopUpUrl, runTopUpUrlSync } from "./lib/top-up-url-sync";

const APPLY = process.argv.includes("--apply");

const { DATABASE_URL, APP_CRED_KEY, CITIZENPAY_API_BASE_URL } = process.env;
if (APPLY && !isPublishableTopUpUrl(probeTopUpUrl())) {
  console.error(
    `Refusing --apply: this environment builds ${probeTopUpUrl()} — set NODE_ENV=production APP_DOMAIN=lacaisse.eu.`,
  );
  process.exit(2);
}
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (APPLY && (!APP_CRED_KEY || !/^[0-9a-fA-F]{64}$/.test(APP_CRED_KEY))) {
  console.error("APP_CRED_KEY must be 64 hex characters (32 bytes).");
  process.exit(1);
}
if (APPLY && !CITIZENPAY_API_BASE_URL) {
  console.error("CITIZENPAY_API_BASE_URL is not set.");
  process.exit(1);
}

// Mirrors services/crypto/secret.ts::decryptSecret. Format MUST stay in sync.
function decryptSecret(envelope: string): string {
  const sep = envelope.indexOf(":");
  if (envelope.slice(0, sep) !== "v1") throw new Error("unsupported envelope");
  const blob = Buffer.from(envelope.slice(sep + 1), "base64");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(APP_CRED_KEY!, "hex"),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

const CAN_CALL_CP =
  Boolean(CITIZENPAY_API_BASE_URL) &&
  Boolean(APP_CRED_KEY && /^[0-9a-fA-F]{64}$/.test(APP_CRED_KEY));

function cpHeaders(apiKeyId: string, apiKey: string): Record<string, string> {
  return {
    "x-api-key-id": apiKeyId,
    "x-api-key": apiKey,
    "content-type": "application/json",
    accept: "application/json",
  };
}

// Mirrors services/citizenpay/live-client.ts::getTreasuryTopUpUrl.
async function readTopUpUrl(apiKeyId: string, apiKey: string): Promise<string | null> {
  const res = await fetch(new URL("/v2/treasury", CITIZENPAY_API_BASE_URL), {
    headers: cpHeaders(apiKeyId, apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const wire = (await res.json()) as { top_up_url?: string | null; topUpUrl?: string | null };
  return wire.top_up_url ?? wire.topUpUrl ?? null;
}

// Mirrors services/citizenpay/api.ts::treasury.setTopUpUrl.
async function setTopUpUrl(
  apiKeyId: string,
  apiKey: string,
  topUpUrl: string | null,
): Promise<void> {
  const res = await fetch(new URL("/v2/treasury", CITIZENPAY_API_BASE_URL), {
    method: "PATCH",
    headers: cpHeaders(apiKeyId, apiKey),
    body: JSON.stringify({ topUpUrl }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

async function main() {
  const funds = await prisma.fund.findMany({
    where: {
      citizenPayApiKeyId: { not: null },
      citizenPayApiKeyEnc: { not: null },
    },
    select: {
      domain: true,
      allocationMode: true,
      citizenPayApiKeyId: true,
      citizenPayApiKeyEnc: true,
    },
    orderBy: { domain: "asc" },
  });
  process.exitCode = await runTopUpUrlSync({
    funds,
    apply: APPLY,
    push: (fund, url) =>
      setTopUpUrl(
        fund.citizenPayApiKeyId!,
        decryptSecret(fund.citizenPayApiKeyEnc!),
        url,
      ),
    read: CAN_CALL_CP
      ? (fund) =>
          readTopUpUrl(
            fund.citizenPayApiKeyId!,
            decryptSecret(fund.citizenPayApiKeyEnc!),
          )
      : undefined,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
