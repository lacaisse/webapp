// SPDX-License-Identifier: AGPL-3.0-or-later
// One-off backfill: publish every SOURCE token account's name to CitizenPay
// (`PUT /v2/treasury/cards/{serial}/profile`). On CP a SOURCE account is a
// card (serial `ACCT-…`), and the public card wallet shows its profile name
// on the cards it backs ("Covered by <name> this week"). Accounts created or
// renamed before the app started publishing on create / rename have none, so
// the wallet falls back to the fund's name.
// Idempotent — re-running just re-sends the same names.
//
// Usage (against prod):
//
//   npx prisma generate
//   DATABASE_URL='<prod-pooled>' npx tsx scripts/sync-account-names.ts
//       # dry run (default): counts only, nothing sent, no CP key needed
//   DATABASE_URL='<prod-pooled>' APP_CRED_KEY=<hex> \
//     CITIZENPAY_API_BASE_URL=https://api2.citizenpay.xyz \
//     npx tsx scripts/sync-account-names.ts --apply
//
// `--verbose` also prints serials and names (otherwise only counts).
//
// Scope: funds with a CP API key; their unarchived SOURCE accounts with a
// serial. The name is sent trimmed; an account with a blank name is skipped
// (CP keeps its default).

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";

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

// Mirrors services/citizenpay/api.ts::cards.setHolderName (same reason): the
// SOURCE account's profile lives on the same per-card route.
// Returns the HTTP status, or "network" when CP couldn't be reached in time.
async function putAccountName(
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
  const total = { accounts: 0, published: 0, noName: 0, failed: 0 };
  const statuses = new Map<string, number>(); // status → count, all funds
  for (const fund of funds) {
    const accounts = await prisma.fundTokenAccount.findMany({
      where: {
        fundId: fund.id,
        kind: "SOURCE",
        serial: { not: null },
        archivedAt: null,
      },
      select: { serial: true, name: true },
      orderBy: { saltNonce: "asc" },
    });
    const creds = APPLY
      ? {
          apiKeyId: fund.citizenPayApiKeyId!,
          apiKey: decryptSecret(fund.citizenPayApiKeyEnc!),
        }
      : null;

    const counts = { published: 0, noName: 0, failed: 0 };
    const failures = new Map<string, number>(); // status → count
    for (const account of accounts) {
      const serial = account.serial!;
      const name = account.name.trim();
      if (!name) {
        counts.noName++;
        continue;
      }
      if (!creds) {
        if (VERBOSE) console.log(`    ${serial} → ${name}`);
        counts.published++;
        continue;
      }
      const status = await putAccountName(creds, serial, name);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      if (status.startsWith("2")) {
        counts.published++;
        if (VERBOSE) console.log(`    ${serial} → ${name}`);
      } else {
        counts.failed++;
        failures.set(status, (failures.get(status) ?? 0) + 1);
        if (VERBOSE) console.warn(`    ${serial}: ${status}`);
      }
    }

    const failNote = failures.size
      ? ` (${[...failures].map(([s, n]) => `${s}×${n}`).join(", ")})`
      : "";
    console.log(
      `  ${fund.domain}: ${accounts.length} source account(s) — ${verb} ${counts.published}, no name ${counts.noName}, failed ${counts.failed}${failNote}`,
    );
    total.accounts += accounts.length;
    total.published += counts.published;
    total.noName += counts.noName;
    total.failed += counts.failed;
  }

  console.log(
    `\nTotal: ${total.accounts} source account(s) — ${verb} ${total.published}, no name ${total.noName}, failed ${total.failed}`,
  );
  if (statuses.size > 0) {
    console.log(
      `Status codes: ${[...statuses].map(([s, n]) => `${s}×${n}`).join(", ")}`,
    );
  }
  if (total.failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
