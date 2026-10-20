// SPDX-License-Identifier: AGPL-3.0-or-later
// One-off backfill: publish every assigned card's holder name to CitizenPay
// (`PUT /v2/treasury/cards/{serial}/profile`), so the public card wallet shows
// it for cards assigned before the app started publishing on assign / rename.
// Idempotent — re-running just re-sends the same names.
//
// Usage (against prod):
//
//   npx prisma generate
//   DATABASE_URL='<prod-pooled>' npx tsx scripts/sync-holder-names.ts
//       # dry run (default): counts only, nothing sent, no CP key needed
//   DATABASE_URL='<prod-pooled>' APP_CRED_KEY=<hex> \
//     CITIZENPAY_API_BASE_URL=https://api2.citizenpay.xyz \
//     npx tsx scripts/sync-holder-names.ts --apply
//
// `--verbose` also prints serials and names (otherwise only counts, plus the
// serials of cards held back for review).
//
// Scope: funds with a CP API key; cards with a serial whose publishable name
// (services/card/holder-name.ts) is non-null — i.e. assigned cards. Unassigned
// cards are left at CP's default `Card <serial>`. Cards whose own holderName
// differs from their member's current name are NOT published (possibly a name
// from before a rename — see `backfillDecision`); they're listed for review.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";
import { backfillDecision } from "../services/card/holder-name";

import { createDecipheriv } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const APP_CRED_KEY = process.env.APP_CRED_KEY;
const BASE_URL = process.env.CITIZENPAY_API_BASE_URL;
if (APPLY) {
  if (!APP_CRED_KEY || !/^[0-9a-fA-F]{64}$/.test(APP_CRED_KEY)) {
    console.error("--apply needs APP_CRED_KEY (64 hex characters / 32 bytes).");
    process.exit(1);
  }
  if (!BASE_URL) {
    console.error("--apply needs CITIZENPAY_API_BASE_URL.");
    process.exit(1);
  }
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
// Returns the HTTP status, or "network" when CP couldn't be reached in time.
async function putHolderName(
  creds: { apiKeyId: string; apiKey: string },
  serial: string,
  name: string,
): Promise<string> {
  const url = new URL(
    `/v2/treasury/cards/${encodeURIComponent(serial)}/profile`,
    BASE_URL,
  );
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "x-api-key-id": creds.apiKeyId,
        "x-api-key": creds.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(5_000),
    });
    await res.text(); // drain; never printed (CP may echo the name)
    return String(res.status);
  } catch {
    return "network";
  }
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
    `${funds.length} connected fund(s)${APPLY ? "" : " — DRY RUN, nothing sent (pass --apply to write)"}`,
  );

  const verb = APPLY ? "published" : "would publish";
  const total = { cards: 0, published: 0, noName: 0, stale: 0, failed: 0 };
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
    const creds = APPLY
      ? {
          apiKeyId: fund.citizenPayApiKeyId!,
          apiKey: decryptSecret(fund.citizenPayApiKeyEnc!),
        }
      : null;

    const counts = { published: 0, noName: 0, failed: 0 };
    const stale: string[] = [];
    const failures = new Map<string, number>(); // status → count
    for (const card of cards) {
      const decision = backfillDecision(card);
      if (decision.kind === "noName") {
        counts.noName++;
        continue;
      }
      if (decision.kind === "stale") {
        stale.push(
          VERBOSE
            ? `${card.serialNumber}: card "${decision.holderName}" vs member "${decision.memberName}"`
            : card.serialNumber,
        );
        continue;
      }
      if (!creds) {
        if (VERBOSE) console.log(`    ${card.serialNumber} → ${decision.name}`);
        counts.published++;
        continue;
      }
      const status = await putHolderName(creds, card.serialNumber, decision.name);
      if (status.startsWith("2")) {
        counts.published++;
        if (VERBOSE) console.log(`    ${card.serialNumber} → ${decision.name}`);
      } else {
        counts.failed++;
        failures.set(status, (failures.get(status) ?? 0) + 1);
        if (VERBOSE) console.warn(`    ${card.serialNumber}: ${status}`);
      }
    }

    const failNote = failures.size
      ? ` (${[...failures].map(([s, n]) => `${s}×${n}`).join(", ")})`
      : "";
    console.log(
      `  ${fund.domain}: ${cards.length} card(s) — ${verb} ${counts.published}, no name ${counts.noName}, held for review ${stale.length}, failed ${counts.failed}${failNote}`,
    );
    if (stale.length > 0) {
      console.log(
        `    held for review (card holderName ≠ member's current name — stale after a rename, or a dependant's card):`,
      );
      for (const line of stale) console.log(`      ${line}`);
    }
    total.cards += cards.length;
    total.published += counts.published;
    total.noName += counts.noName;
    total.stale += stale.length;
    total.failed += counts.failed;
  }

  console.log(
    `\nTotal: ${total.cards} card(s) — ${verb} ${total.published}, no name ${total.noName}, held for review ${total.stale}, failed ${total.failed}`,
  );
  if (total.failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
