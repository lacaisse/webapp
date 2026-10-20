// SPDX-License-Identifier: AGPL-3.0-or-later
// One-off backfill: publish every assigned card's holder name to CitizenPay
// (`PUT /v2/treasury/cards/{serial}/profile`), so the public card wallet shows
// it for cards assigned before the app started publishing on assign / rename.
// Idempotent — re-running just re-sends the same names.
//
// Usage (against prod):
//
//   npx prisma generate
//   DATABASE_URL='<prod-pooled>' APP_CRED_KEY=<hex> \
//     CITIZENPAY_API_BASE_URL=https://api2.citizenpay.xyz \
//     npx tsx scripts/sync-holder-names.ts [--dry]
//
// `--dry` lists what would be sent without calling CitizenPay.
//
// Scope: funds with a CP API key; cards with a serial whose publishable name
// (services/card/holder-name.ts) is non-null — i.e. assigned cards. Unassigned
// cards are left at CP's default `Card <serial>`.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";
import { publishedHolderName } from "../services/card/holder-name";

import { createDecipheriv } from "node:crypto";

const DRY = process.argv.includes("--dry");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const APP_CRED_KEY = process.env.APP_CRED_KEY;
if (!APP_CRED_KEY || !/^[0-9a-fA-F]{64}$/.test(APP_CRED_KEY)) {
  console.error("APP_CRED_KEY must be 64 hex characters (32 bytes).");
  process.exit(1);
}
const BASE_URL = process.env.CITIZENPAY_API_BASE_URL;
if (!BASE_URL && !DRY) {
  console.error("CITIZENPAY_API_BASE_URL is not set (or pass --dry).");
  process.exit(1);
}

// Inline AES-256-GCM envelope decrypt. Mirrors services/crypto/secret.ts; not
// imported because that module is `server-only` and won't load outside
// Next.js. Format MUST stay in sync: `v1:` + base64(iv[12] ‖ tag[16] ‖ ct).
function decryptSecret(envelope: string): string {
  const [version, b64] = envelope.split(":", 2);
  if (version !== "v1" || !b64) throw new Error("unsupported secret envelope");
  const blob = Buffer.from(b64, "base64");
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

// Mirrors services/citizenpay/api.ts::cards.setHolderName (same reason).
async function putHolderName(
  creds: { apiKeyId: string; apiKey: string },
  serial: string,
  name: string,
): Promise<number> {
  const url = new URL(
    `/v2/treasury/cards/${encodeURIComponent(serial)}/profile`,
    BASE_URL,
  );
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "x-api-key-id": creds.apiKeyId,
      "x-api-key": creds.apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  });
  await res.text(); // drain
  return res.status;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
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
    },
    orderBy: { domain: "asc" },
  });
  console.log(
    `${funds.length} connected fund(s)${DRY ? " (dry-run — nothing sent)" : ""}`,
  );

  const total = { cards: 0, published: 0, noName: 0, failed: 0 };
  for (const fund of funds) {
    const cards = await prisma.card.findMany({
      where: { fundId: fund.id, serialNumber: { not: "" } },
      select: {
        serialNumber: true,
        memberId: true,
        holderName: true,
        member: { select: { firstName: true, lastName: true } },
      },
      orderBy: { serialNumber: "asc" },
    });
    const creds = DRY
      ? null
      : {
          apiKeyId: fund.citizenPayApiKeyId!,
          apiKey: decryptSecret(fund.citizenPayApiKeyEnc!),
        };

    const counts = { published: 0, noName: 0, failed: 0 };
    const failures = new Map<string, number>(); // status → count
    for (const card of cards) {
      const name = publishedHolderName(card);
      if (!name) {
        counts.noName++;
        continue;
      }
      if (!creds) {
        console.log(`    ${card.serialNumber} → ${name}`);
        counts.published++;
        continue;
      }
      let status: string;
      try {
        status = String(await putHolderName(creds, card.serialNumber, name));
      } catch (e) {
        status = e instanceof Error ? e.name : "error";
      }
      if (status.startsWith("2")) {
        counts.published++;
      } else {
        counts.failed++;
        failures.set(status, (failures.get(status) ?? 0) + 1);
        if (counts.failed <= 5) {
          console.warn(`    ${card.serialNumber}: ${status}`);
        }
      }
    }

    const failNote = failures.size
      ? ` (${[...failures].map(([s, n]) => `${s}×${n}`).join(", ")})`
      : "";
    console.log(
      `  ${fund.domain}: ${cards.length} card(s) — ${DRY ? "would publish" : "published"} ${counts.published}, no name ${counts.noName}, failed ${counts.failed}${failNote}`,
    );
    total.cards += cards.length;
    total.published += counts.published;
    total.noName += counts.noName;
    total.failed += counts.failed;
  }

  console.log(
    `\nTotal: ${total.cards} card(s) — ${DRY ? "would publish" : "published"} ${total.published}, no name ${total.noName}, failed ${total.failed}`,
  );
  if (total.failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
