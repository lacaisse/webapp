// SPDX-License-Identifier: AGPL-3.0-or-later
/* eslint-disable no-console */
// One-off backfill: generate a per-fund minter keypair for every Fund that
// pre-dates the auto-generation in createFundAction. Idempotent — funds
// already carrying `tokenMinterPrivateKeyEnc` are skipped.
//
// Usage (against prod):
//
//   npx prisma generate
//   DATABASE_URL='<prod-pooled>' DIRECT_URL='<prod-direct>' APP_CRED_KEY=<hex> \
//     npx tsx scripts/backfill-fund-minters.ts
//
// Pass `--dry` to print what would be written without touching the DB.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { PrismaClient } from "../services/db/generated/client";

import { createCipheriv, randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const APP_CRED_KEY = process.env.APP_CRED_KEY;
if (!APP_CRED_KEY || !/^[0-9a-fA-F]{64}$/.test(APP_CRED_KEY)) {
  console.error("APP_CRED_KEY must be 64 hex characters (32 bytes).");
  process.exit(1);
}

// Inline AES-256-GCM envelope. Mirrors services/crypto/secret.ts; not
// imported because that module is `server-only` and won't load outside
// Next.js. Format MUST stay in sync.
const VERSION = "v1";
const IV_LEN = 12;
function encryptSecret(plaintext: string): string {
  const key = Buffer.from(APP_CRED_KEY!, "hex");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

const DRY = process.argv.includes("--dry");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Smart-account derivation moved to services/citizenpay/connect.ts —
// it needs CP's per-treasury factory address, which we only learn from
// `GET /v2/treasury` at connect time. Funds backfilled here will get
// their SA populated next time they (re)connect to Citizen Pay.

async function main() {
  const funds = await prisma.fund.findMany({
    where: { tokenMinterPrivateKeyEnc: null },
    select: { id: true, domain: true },
  });
  if (funds.length === 0) {
    console.log("No funds missing a minter — nothing to do.");
    return;
  }

  console.log(`Backfilling ${funds.length} fund(s)${DRY ? " (dry-run)" : ""}…`);
  for (const fund of funds) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const privateKeyEnc = encryptSecret(privateKey);
    console.log(`  ${fund.domain} → ${account.address}`);
    if (!DRY) {
      await prisma.fund.update({
        where: { id: fund.id },
        data: {
          tokenMinterPrivateKeyEnc: privateKeyEnc,
          tokenMinterEoaAddress: account.address,
        },
      });
    }
  }
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
