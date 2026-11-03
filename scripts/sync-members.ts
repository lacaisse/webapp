// SPDX-License-Identifier: AGPL-3.0-or-later
// Replay of the member declarations (services/member/api-sync.ts): re-sends
// each member's state — `PUT /v2/treasury/members/{holder_ref} {cards}` for a
// member with a verified login at a fund with member login on (cards = the
// serials of the fund's own cards bound to them), `DELETE` otherwise — for
// every member of the connected funds that may be declared or may have been
// (a login, or a stamp) and that Citizen Pay has not accepted yet
// (`Member.apiSyncedAt IS NULL`). Needed once after the api PR that adds the
// route is deployed (until then every sync answered 404 and stamped
// nothing), and harmless afterwards: the state is recomputed from the rows,
// so re-running sends the same thing.
//
// Usage (against prod):
//
//   npx prisma generate
//   DATABASE_URL='<prod-pooled>' npx tsx scripts/sync-members.ts
//       # dry run (default): counts only, nothing sent, no CP key needed
//   DATABASE_URL='<prod-pooled>' APP_CRED_KEY=<hex> \
//     CITIZENPAY_API_BASE_URL=https://api2.citizenpay.xyz \
//     npx tsx scripts/sync-members.ts --apply [--all] [--verbose]
//
// `--all` also re-sends members already stamped (a full resync). `--verbose`
// prints holder refs (user ids) and card counts — never names or emails.
//
// A member whose login is gone has no holder ref left on the row; the
// "remove my login" action withdrew it at the time, so it is skipped here
// (counted as "nothing to undeclare").

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

// Mirrors services/card/serial.ts `normalizeSerial` (a plain module, but the
// script stays self-contained like the card holder replay).
function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase();
}

// Mirrors services/citizenpay/api.ts `members.put` / `members.delete`.
async function sendMember(
  creds: { apiKeyId: string; apiKey: string },
  holderRef: string,
  cards: string[] | null,
): Promise<string> {
  const url = new URL(`/v2/treasury/members/${encodeURIComponent(holderRef)}`, BASE_URL);
  try {
    const res = await fetch(url, {
      method: cards === null ? "DELETE" : "PUT",
      headers: {
        "x-api-key-id": creds.apiKeyId,
        "x-api-key": creds.apiKey,
        accept: "application/json",
        ...(cards === null ? {} : { "content-type": "application/json" }),
      },
      body: cards === null ? undefined : JSON.stringify({ cards }),
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
      citizenPayApiKeyId: { not: null },
      citizenPayApiKeyEnc: { not: null },
    },
    select: {
      id: true,
      name: true,
      memberLoginEnabled: true,
      citizenPayApiKeyId: true,
      citizenPayApiKeyEnc: true,
    },
  });
  console.log(`${funds.length} connected fund(s)${APPLY ? "" : " (dry run)"}`);

  let declared = 0;
  let undeclared = 0;
  let nothing = 0;
  let sent = 0;
  const byCode = new Map<string, number>();

  for (const fund of funds) {
    const members = await prisma.member.findMany({
      where: {
        fundId: fund.id,
        ...(ALL ? {} : { apiSyncedAt: null }),
        // Only what may be declared, or may have been (see the header).
        OR: [{ userId: { not: null } }, { apiSyncedAt: { not: null } }],
      },
      select: {
        id: true,
        userId: true,
        emailVerifiedAt: true,
        cards: {
          // Enrolled copies are another fund's serials: only the issuer vouches.
          where: { enrolledFromRequest: null },
          select: { serialNumber: true },
        },
      },
    });
    const creds = APPLY
      ? { apiKeyId: fund.citizenPayApiKeyId!, apiKey: decryptSecret(fund.citizenPayApiKeyEnc!) }
      : null;
    console.log(`- ${fund.name}${fund.memberLoginEnabled ? "" : " (member login off)"}: ${members.length} member(s) to sync`);
    for (const member of members) {
      if (!member.userId) {
        nothing++;
        continue;
      }
      const cards =
        fund.memberLoginEnabled && member.emailVerifiedAt
          ? [...new Set(member.cards.map((c) => normalizeSerial(c.serialNumber)))].sort()
          : null;
      if (cards) declared++;
      else undeclared++;
      if (VERBOSE) {
        console.log(`    ${member.userId} → ${cards ? `PUT (${cards.length} card(s))` : "DELETE"}`);
      }
      if (!creds) continue;
      const code = await sendMember(creds, member.userId, cards);
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
      if (code.startsWith("2")) {
        sent++;
        await prisma.member.update({ where: { id: member.id }, data: { apiSyncedAt: new Date() } });
      } else if (code === "network") {
        console.error("  network failure — stopping this fund");
        break;
      }
    }
  }

  console.log(
    `declare: ${declared}, undeclare: ${undeclared}, nothing to undeclare: ${nothing}${APPLY ? `, accepted: ${sent}` : ""}`,
  );
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
