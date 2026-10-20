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
//     npx tsx scripts/sync-top-up-urls.ts [--dry]
//
// `--dry` prints what would be pushed without calling CitizenPay.
//
// The service layer (client factory, api.ts, crypto/secret.ts, db/prisma.ts)
// is `server-only` and won't load outside Next.js, so — like the other
// scripts — this builds its own PrismaClient and inlines the decrypt + the
// PATCH. Only the pure URL rule is shared with the app.

import "dotenv/config";
import { createDecipheriv } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";
import { topUpUrlFor } from "../services/citizenpay/top-up-url";

const DRY = process.argv.includes("--dry");

const { DATABASE_URL, APP_CRED_KEY, CITIZENPAY_API_BASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (!DRY && (!APP_CRED_KEY || !/^[0-9a-fA-F]{64}$/.test(APP_CRED_KEY))) {
  console.error("APP_CRED_KEY must be 64 hex characters (32 bytes).");
  process.exit(1);
}
if (!DRY && !CITIZENPAY_API_BASE_URL) {
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

// Mirrors services/citizenpay/api.ts::treasury.setTopUpUrl.
async function setTopUpUrl(
  apiKeyId: string,
  apiKey: string,
  topUpUrl: string | null,
): Promise<void> {
  const res = await fetch(new URL("/v2/treasury", CITIZENPAY_API_BASE_URL), {
    method: "PATCH",
    headers: {
      "x-api-key-id": apiKeyId,
      "x-api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
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
  console.log(`${funds.length} connected fund(s)${DRY ? " (dry run)" : ""}`);

  let failed = 0;
  for (const fund of funds) {
    const url = topUpUrlFor(fund);
    const label = `  ${fund.domain} [${fund.allocationMode}] → ${url ?? "(clear)"}`;
    if (DRY) {
      console.log(label);
      continue;
    }
    try {
      await setTopUpUrl(
        fund.citizenPayApiKeyId!,
        decryptSecret(fund.citizenPayApiKeyEnc!),
        url,
      );
      console.log(`${label}: ok`);
    } catch (e) {
      failed++;
      console.log(`${label}: FAILED ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
