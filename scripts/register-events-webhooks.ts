// SPDX-License-Identifier: AGPL-3.0-or-later
// One-off: register every connected fund's treasury events webhook with
// Citizen Pay (`PATCH /v2/treasury { eventsWebhookUrl, eventsWebhookSecret }`,
// see services/citizenpay/events-webhook.ts). The app registers it on its own
// at connect time and from Settings → Citizen Pay; this catches funds
// connected before the webhook existed (2026-11-03), whose top-ups otherwise
// wait for the cron instead of settling on `topup.pending`, and funds whose
// registration failed. Idempotent — safe to re-run.
//
// Usage (against prod — NODE_ENV=production makes the url https without a
// port, exactly as the deployed app builds it):
//
//   npx prisma generate
//   NODE_ENV=production APP_DOMAIN=lacaisse.eu \
//   DATABASE_URL='<prod-pooled>' APP_CRED_KEY=<hex> \
//   CITIZENPAY_API_BASE_URL=<cp-base-url> \
//     npx tsx scripts/register-events-webhooks.ts            # dry run: prints the plan
//     npx tsx scripts/register-events-webhooks.ts --apply    # registers the missing ones
//     npx tsx scripts/register-events-webhooks.ts --apply --force  # re-registers every fund
//
// Dry run is the default. `--apply` refuses to write anything unless the
// url is https. Only funds with no registration on record (or a recorded
// failure) are touched; `--force` re-registers all of them (a fund that
// moved domain, a secret the api lost).
//
// The secret follows the service's rule: a stored one
// (Fund.citizenPayEventsSecretEnc) is re-sent; a fund without one gets a
// fresh 32-byte secret, stored encrypted BEFORE it is sent, so the api never
// signs with a secret La Caisse does not hold. Logic lives in
// scripts/lib/events-webhook-sync.ts.
//
// The service layer is `server-only` and won't load outside Next.js, so —
// like the other scripts — this builds its own PrismaClient and inlines the
// crypto + the PATCH. Only the pure url rules are shared with the app.

import "dotenv/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";

import { runEventsWebhookSync } from "./lib/events-webhook-sync";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

const { DATABASE_URL, APP_CRED_KEY, CITIZENPAY_API_BASE_URL } = process.env;
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

// Mirrors services/crypto/secret.ts (v1 envelope, no AAD). Format MUST stay
// in sync.
function decryptSecret(envelope: string): string {
  const sep = envelope.indexOf(":");
  if (envelope.slice(0, sep) !== "v1") throw new Error("unsupported envelope");
  const blob = Buffer.from(envelope.slice(sep + 1), "base64");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(APP_CRED_KEY!, "hex"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(APP_CRED_KEY!, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

// Mirrors services/citizenpay/api.ts::treasury.setEventsWebhook.
async function setEventsWebhook(
  apiKeyId: string,
  apiKey: string,
  webhook: { url: string; secret: string },
): Promise<void> {
  const res = await fetch(new URL("/v2/treasury", CITIZENPAY_API_BASE_URL), {
    method: "PATCH",
    headers: {
      "x-api-key-id": apiKeyId,
      "x-api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ eventsWebhookUrl: webhook.url, eventsWebhookSecret: webhook.secret }),
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
      id: true,
      domain: true,
      citizenPayApiKeyId: true,
      citizenPayApiKeyEnc: true,
      citizenPayEventsSecretEnc: true,
      citizenPayEventsWebhookRegisteredAt: true,
      citizenPayEventsWebhookError: true,
    },
    orderBy: { domain: "asc" },
  });
  process.exitCode = await runEventsWebhookSync({
    funds,
    apply: APPLY,
    force: FORCE,
    register: async (fund, url) => {
      let secret: string;
      if (fund.citizenPayEventsSecretEnc) {
        secret = decryptSecret(fund.citizenPayEventsSecretEnc);
      } else {
        secret = randomBytes(32).toString("hex");
        await prisma.fund.update({
          where: { id: fund.id },
          data: { citizenPayEventsSecretEnc: encryptSecret(secret) },
        });
      }
      try {
        await setEventsWebhook(
          fund.citizenPayApiKeyId!,
          decryptSecret(fund.citizenPayApiKeyEnc!),
          { url, secret },
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await prisma.fund.update({
          where: { id: fund.id },
          data: { citizenPayEventsWebhookError: message.slice(0, 500) },
        });
        throw e;
      }
      await prisma.fund.update({
        where: { id: fund.id },
        data: { citizenPayEventsWebhookRegisteredAt: new Date(), citizenPayEventsWebhookError: null },
      });
    },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
