// SPDX-License-Identifier: AGPL-3.0-or-later
// One-off: mark every connected fund's CitizenPay treasury a `fund`
// (`PATCH /v2/treasury { kind: "fund" }`, api#260 — what the Citizen Wallet
// lists; the api creates every treasury as a plain `token`). The app does it
// on its own from now on (CP connect + General settings save, via
// services/citizenpay/sync-fund-kind.ts); this catches the funds connected
// before that existed, and any whose sync failed while the api predated the
// field. Idempotent — safe to re-run.
//
// Usage (against prod):
//
//   npx prisma generate
//   DATABASE_URL='<prod-pooled>' APP_CRED_KEY=<hex> \
//   CITIZENPAY_API_BASE_URL=https://api2.citizenpay.xyz \
//     npx tsx scripts/sync-fund-kind.ts [--dry]      # dry run: prints the plan
//     npx tsx scripts/sync-fund-kind.ts --apply      # writes it
//
// Dry run is the default (`--dry` says so explicitly). It reads each
// treasury's current slug and kind when APP_CRED_KEY + CITIZENPAY_API_BASE_URL
// are set, so it tells "(already fund)" from "set kind=fund (now token)";
// without them it only lists the funds. `--apply` needs both, writes only the
// treasuries not already a fund, and never sends `token`. Logic lives in
// scripts/lib/fund-kind-sync.ts.
//
// The service layer (client factory, api.ts, crypto/secret.ts, db/prisma.ts)
// is `server-only` and won't load outside Next.js, so — like the other
// scripts — this builds its own PrismaClient and inlines the decrypt + the
// GET / PATCH.

import "dotenv/config";
import { createDecipheriv } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";
import type { TreasuryKind } from "../services/citizenpay/types";

import { runFundKindSync, type TreasuryKindRead } from "./lib/fund-kind-sync";

const APPLY = process.argv.includes("--apply");
const DRY = process.argv.includes("--dry");
if (APPLY && DRY) {
  console.error("Pass either --dry (the default) or --apply, not both.");
  process.exit(2);
}

const { DATABASE_URL, APP_CRED_KEY, CITIZENPAY_API_BASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const KEY_OK = Boolean(APP_CRED_KEY && /^[0-9a-fA-F]{64}$/.test(APP_CRED_KEY));
if (APPLY && !KEY_OK) {
  console.error("APP_CRED_KEY must be 64 hex characters (32 bytes).");
  process.exit(1);
}
if (APPLY && !CITIZENPAY_API_BASE_URL) {
  console.error("CITIZENPAY_API_BASE_URL is not set.");
  process.exit(1);
}

// Mirrors services/crypto/secret.ts::decryptSecret for the `v1` envelope the
// api key is stored in. Format MUST stay in sync.
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

const CAN_CALL_CP = Boolean(CITIZENPAY_API_BASE_URL) && KEY_OK;

function cpHeaders(apiKeyId: string, apiKey: string): Record<string, string> {
  return {
    "x-api-key-id": apiKeyId,
    "x-api-key": apiKey,
    "content-type": "application/json",
    accept: "application/json",
  };
}

// Mirrors services/citizenpay/api.ts::treasury.get (slug + kind only).
async function readTreasury(apiKeyId: string, apiKey: string): Promise<TreasuryKindRead> {
  const res = await fetch(new URL("/v2/treasury", CITIZENPAY_API_BASE_URL), {
    headers: cpHeaders(apiKeyId, apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const wire = (await res.json()) as { slug?: string | null; kind?: string | null };
  const kind = wire.kind === "fund" || wire.kind === "token" ? (wire.kind as TreasuryKind) : null;
  return { slug: wire.slug ?? null, kind };
}

// Mirrors services/citizenpay/api.ts::treasury.setKind.
async function setKind(apiKeyId: string, apiKey: string, kind: TreasuryKind): Promise<void> {
  const res = await fetch(new URL("/v2/treasury", CITIZENPAY_API_BASE_URL), {
    method: "PATCH",
    headers: cpHeaders(apiKeyId, apiKey),
    body: JSON.stringify({ kind }),
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
      citizenPayApiKeyId: true,
      citizenPayApiKeyEnc: true,
    },
    orderBy: { domain: "asc" },
  });
  process.exitCode = await runFundKindSync({
    funds,
    apply: APPLY,
    push: (fund) =>
      setKind(
        fund.citizenPayApiKeyId!,
        decryptSecret(fund.citizenPayApiKeyEnc!),
        "fund",
      ),
    read: CAN_CALL_CP
      ? (fund) =>
          readTreasury(
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
