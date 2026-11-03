// SPDX-License-Identifier: AGPL-3.0-or-later
// Replay of the card holder sync (services/card/holder-sync.ts): re-sends the
// holder state — `PUT /v2/treasury/cards/{serial}/holder {holder_ref}` for a
// card bound to a member with a verified login, `DELETE` otherwise — for every
// card of the funds that turned member login on and that Citizen Pay has not
// accepted yet (`Card.holderSyncedAt IS NULL`). Needed once after the api PR
// that adds the route is deployed (until then every sync answered 404 and
// stamped nothing), and harmless afterwards: the state is recomputed from the
// rows, so re-running sends the same thing.
//
// Usage (against prod):
//
//   npx prisma generate
//   DATABASE_URL='<prod-pooled>' npx tsx scripts/sync-card-holders.ts
//       # dry run (default): counts only, nothing sent, no CP key needed
//   DATABASE_URL='<prod-pooled>' APP_CRED_KEY=<hex> \
//     CITIZENPAY_API_BASE_URL=https://api2.citizenpay.xyz \
//     npx tsx scripts/sync-card-holders.ts --apply [--all] [--verbose]
//
// `--all` also re-sends cards already stamped (a full resync). `--verbose`
// prints serials (never holder refs' owners — the ref is a user id).

import "dotenv/config";
import { createDecipheriv } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
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
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(APP_CRED_KEY!, "hex"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// Mirrors services/citizenpay/api.ts `cards.setHolder` / `cards.clearHolder`.
async function sendHolder(
  creds: { apiKeyId: string; apiKey: string },
  serial: string,
  holderRef: string | null,
): Promise<string> {
  const url = new URL(`/v2/treasury/cards/${encodeURIComponent(serial)}/holder`, BASE_URL);
  try {
    const res = await fetch(url, {
      method: holderRef === null ? "DELETE" : "PUT",
      headers: {
        "x-api-key-id": creds.apiKeyId,
        "x-api-key": creds.apiKey,
        accept: "application/json",
        ...(holderRef === null ? {} : { "content-type": "application/json" }),
      },
      body: holderRef === null ? undefined : JSON.stringify({ holder_ref: holderRef }),
      signal: AbortSignal.timeout(5_000),
    });
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
      memberLoginEnabled: true,
      citizenPayApiKeyId: { not: null },
      citizenPayApiKeyEnc: { not: null },
    },
    select: { id: true, name: true, citizenPayApiKeyId: true, citizenPayApiKeyEnc: true },
  });
  console.log(`${funds.length} fund(s) with member login and a CP key${APPLY ? "" : " (dry run)"}`);

  let attached = 0;
  let detached = 0;
  let sent = 0;
  const byCode = new Map<string, number>();

  for (const fund of funds) {
    const cards = await prisma.card.findMany({
      where: {
        fundId: fund.id,
        ...(ALL ? {} : { holderSyncedAt: null }),
        // Enrolled copies are never attached by this fund (only the issuer).
        enrolledFromRequest: null,
      },
      select: {
        id: true,
        serialNumber: true,
        member: { select: { userId: true, emailVerifiedAt: true } },
      },
    });
    const creds = APPLY
      ? { apiKeyId: fund.citizenPayApiKeyId!, apiKey: decryptSecret(fund.citizenPayApiKeyEnc!) }
      : null;
    console.log(`- ${fund.name}: ${cards.length} card(s) to sync`);
    for (const card of cards) {
      const holderRef =
        card.member?.userId && card.member.emailVerifiedAt ? card.member.userId : null;
      if (holderRef) attached++;
      else detached++;
      if (VERBOSE) console.log(`    ${card.serialNumber} → ${holderRef ? "PUT" : "DELETE"}`);
      if (!creds) continue;
      const code = await sendHolder(creds, card.serialNumber, holderRef);
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
      if (code.startsWith("2")) {
        sent++;
        await prisma.card.update({ where: { id: card.id }, data: { holderSyncedAt: new Date() } });
      } else if (code === "network") {
        console.error("  network failure — stopping this fund");
        break;
      }
    }
  }

  console.log(`attach: ${attached}, detach: ${detached}${APPLY ? `, accepted: ${sent}` : ""}`);
  if (byCode.size > 0) {
    console.log("statuses:", [...byCode].map(([c, n]) => `${c}×${n}`).join(", "));
    if (byCode.has("404")) console.log("404 = the api route is not deployed yet; nothing was stamped for those.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
