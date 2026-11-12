// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic seed for a staging deployment (docs/container.md). Fake funds,
// staff, members, cards and merchants, enough for every page and the ten
// cron routes to have something to work on. No real data: obviously fake
// names, addresses under example.org (reserved, cannot receive mail),
// made-up serials and account addresses.
//
//   SEED_SYNTHETIC_OK=1 DATABASE_URL=… npx tsx scripts/seed-staging.ts
//
// In the container image it is bundled to release/seed-staging.mjs and run
// by `node release/release.mjs --seed` after the migrations.
//
// Two guards, both refuse with exit code 2 before anything is written:
//   1. SEED_SYNTHETIC_OK must be exactly "1".
//   2. The database holds no fund the seed did not create. Seeded funds have
//      fixed ids (SEED_FUNDS below); any other Fund row means this is not a
//      synthetic database (production, or a staging someone has used for
//      real), and the seed stops.
//
// Idempotent: every row is found by a natural key and created only when
// missing; a second run writes nothing new. Encrypted columns are written
// once, under the APP_CRED_KEY of the first run, and never touched again, so
// a key rotation's re-encryption has real cells to walk (they hold a fake
// API key and a freshly generated, never-funded minter key).
//
// Optional SEED_STAFF_PASSWORD: the password of the seeded staff accounts
// (set on creation, and reset to it on each run). Unset, the staff accounts
// have no password; with email disabled on staging they then cannot sign in.
//
// Works with the Citizen Pay client in mock mode (CITIZENPAY_API_BASE_URL
// unset): the funds carry a fake treasury id so the crons pick them up, and
// the mock answers for every call.

import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { privateKeyToAccount } from "viem/accounts";

import {
  type AllocationMode,
  type FundRole,
  PrismaClient,
} from "../services/db/generated/client";
import { pgTlsConfig } from "../services/db/tls";
import { encryptWith, parseHexKey } from "./lib/app-cred-rotation";

// -----------------------------------------------------------------------------
// What gets seeded
// -----------------------------------------------------------------------------

type SeedFund = {
  id: string;
  domain: string; // canonical Fund.domain (see services/fund/host.ts)
  name: string;
  tokenSymbol: string;
  allocationMode: AllocationMode;
  memberLoginEnabled: boolean;
  // Hosting waived (settled). The one fund left unsettled shows the setup
  // checklist's subscription step and lets an OWNER accept it.
  waived: boolean;
  members: number;
};

export const SEED_FUNDS: SeedFund[] = [
  {
    // Served at alpha.<APP_DOMAIN> (alpha.staging.lacaisse.eu on staging).
    id: "seed-synthetic-fund-alpha",
    domain: "alpha.lacaisse.eu",
    name: "Synthetic Fund Alpha",
    tokenSymbol: "SYNA",
    allocationMode: "FIXED_PERIOD",
    memberLoginEnabled: true,
    waived: true,
    members: 8,
  },
  {
    id: "seed-synthetic-fund-beta",
    domain: "beta.lacaisse.eu",
    name: "Synthetic Fund Beta",
    tokenSymbol: "SYNB",
    allocationMode: "PAY_AND_GO",
    memberLoginEnabled: false,
    waived: false,
    members: 5,
  },
  {
    // A custom domain value. example.org is reserved: nothing resolves to
    // the runner, so this tests the hostname check, not a live site.
    id: "seed-synthetic-fund-gamma",
    domain: "caisse-gamma.example.org",
    name: "Synthetic Fund Gamma",
    tokenSymbol: "SYNG",
    allocationMode: "FIXED_PERIOD",
    memberLoginEnabled: false,
    waived: true,
    members: 4,
  },
];

const SEED_FUND_IDS = new Set(SEED_FUNDS.map((f) => f.id));

const PLATFORM_ADMIN_EMAIL = "platform-admin@example.org";

function staffFor(fund: SeedFund): { email: string; name: string; role: FundRole }[] {
  const slug = fund.id.replace("seed-synthetic-fund-", "");
  return [
    { email: `owner.${slug}@example.org`, name: `Test Owner ${slug}`, role: "OWNER" },
    { email: `operator.${slug}@example.org`, name: `Test Operator ${slug}`, role: "OPERATOR" },
  ];
}

// Deterministic fake 20-byte address from a label: stable across runs, never
// a key anyone holds.
function fakeAddress(label: string): string {
  return `0x${createHash("sha256").update(`seed-synthetic:${label}`).digest("hex").slice(0, 40)}`;
}

// Deterministic fake UUID (the treasury id the mock never checks).
function fakeUuid(label: string): string {
  const h = createHash("sha256").update(`seed-synthetic-uuid:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------

export class SeedRefused extends Error {}

export function checkSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.SEED_SYNTHETIC_OK !== "1") {
    throw new SeedRefused(
      "Refusing to seed: set SEED_SYNTHETIC_OK=1 to seed synthetic data into this database.",
    );
  }
}

export function foreignFundIds(existingIds: string[]): string[] {
  return existingIds.filter((id) => !SEED_FUND_IDS.has(id));
}

// -----------------------------------------------------------------------------
// Seed
// -----------------------------------------------------------------------------

type Db = PrismaClient;

async function upsertUser(
  db: Db,
  email: string,
  name: string,
  passwordHash: string | null,
  globalRole: "USER" | "ADMIN" = "USER",
): Promise<string> {
  const user =
    (await db.user.findUnique({ where: { email }, select: { id: true } })) ??
    (await db.user.create({
      data: { email, name, emailVerified: true, globalRole },
      select: { id: true },
    }));
  if (passwordHash) {
    // Better Auth's credential account: accountId = the user id.
    const existing = await db.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
      select: { id: true },
    });
    if (existing) {
      await db.account.update({ where: { id: existing.id }, data: { password: passwordHash } });
    } else {
      await db.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: passwordHash,
        },
      });
    }
  }
  return user.id;
}

async function seedFund(
  db: Db,
  fund: SeedFund,
  appCredKey: Buffer | null,
  passwordHash: string | null,
): Promise<{ created: boolean }> {
  const existing = await db.fund.findUnique({ where: { id: fund.id }, select: { id: true } });
  let created = false;
  if (!existing) {
    created = true;
    // A freshly generated minter key: it has never held anything and is
    // granted nothing anywhere. Stored only so the encrypted column exists.
    const minterKey = `0x${randomBytes(32).toString("hex")}` as const;
    await db.fund.create({
      data: {
        id: fund.id,
        domain: fund.domain,
        name: fund.name,
        fullName: `${fund.name} (synthetic test data)`,
        tokenName: `${fund.name} Token`,
        tokenSymbol: fund.tokenSymbol,
        tokenDecimals: 6,
        tokenAddress: fakeAddress(`${fund.id}:token`),
        allocationMode: fund.allocationMode,
        memberLoginEnabled: fund.memberLoginEnabled,
        defaultLocale: "en",
        websiteUrl: "https://example.org/",
        citizenPayFundId: fakeUuid(`${fund.id}:treasury`),
        citizenPayTreasurySlug: fund.id.replace("seed-synthetic-fund-", "syn-"),
        citizenPayApiKeyId: appCredKey ? fakeAddress(`${fund.id}:api-key`) : null,
        citizenPayApiKeyEnc: appCredKey
          ? encryptWith(appCredKey, `synthetic-api-key-${fund.id}`, "v1")
          : null,
        tokenMinterEoaAddress: appCredKey ? privateKeyToAccount(minterKey).address : null,
        tokenMinterPrivateKeyEnc: appCredKey ? encryptWith(appCredKey, minterKey, "v1") : null,
        subscriptionWaivedAt: fund.waived ? new Date() : null,
        subscriptionWaiverReason: fund.waived ? "Synthetic staging fund" : null,
        billingEmail: `billing.${fund.id.replace("seed-synthetic-fund-", "")}@example.org`,
      },
    });
  }

  for (const s of staffFor(fund)) {
    const userId = await upsertUser(db, s.email, s.name, passwordHash);
    await db.fundMember.upsert({
      where: { userId_fundId: { userId, fundId: fund.id } },
      create: { userId, fundId: fund.id, role: s.role },
      update: {},
    });
  }

  const tierNames = ["Standard", "Solidaire"];
  for (const [position, name] of tierNames.entries()) {
    await db.allocationTier.upsert({
      where: { fundId_name: { fundId: fund.id, name } },
      create: {
        fundId: fund.id,
        name,
        position,
        minContribution: position === 0 ? 20 : 5,
        maxContribution: position === 0 ? 100 : 19.99,
        allocationAmount: position === 0 ? 50 : 30,
      },
      update: {},
    });
  }
  const standard = await db.allocationTier.findUniqueOrThrow({
    where: { fundId_name: { fundId: fund.id, name: "Standard" } },
    select: { id: true },
  });

  const slug = fund.id.replace("seed-synthetic-fund-", "");
  for (let i = 1; i <= fund.members; i++) {
    const n = String(i).padStart(2, "0");
    const email = `member${n}.${slug}@example.org`;
    const member = await db.member.upsert({
      where: { fundId_email: { fundId: fund.id, email } },
      create: {
        fundId: fund.id,
        email,
        firstName: "Test",
        lastName: `Member ${n}`,
        locale: "en",
        status: i <= fund.members - 1 ? "ACTIVE" : "NEW",
        tierId: standard.id,
        contributionAmount: 25,
        paymentReference: `SYN${slug.toUpperCase()}${n}`,
        address: `${i} Example Street`,
        postalCode: "0000",
        city: "Testville",
        emailVerifiedAt: new Date(),
      },
      update: {},
      select: { id: true, primaryCardId: true },
    });
    const serialNumber = `SYN-${slug.toUpperCase()}-${n}`;
    const card = await db.card.upsert({
      where: { fundId_serialNumber: { fundId: fund.id, serialNumber } },
      create: {
        fundId: fund.id,
        serialNumber,
        account: fakeAddress(`${fund.id}:card:${n}`),
        number: i,
        holderName: `Test Member ${n}`,
        status: i % 4 === 0 ? "INACTIVE" : "ACTIVE",
        memberId: member.id,
        issuedAt: new Date(),
      },
      update: {},
      select: { id: true },
    });
    if (!member.primaryCardId) {
      await db.member.update({ where: { id: member.id }, data: { primaryCardId: card.id } });
    }
  }

  // Two spare cards in stock, not assigned to anyone.
  for (const n of ["90", "91"]) {
    const serialNumber = `SYN-${slug.toUpperCase()}-${n}`;
    await db.card.upsert({
      where: { fundId_serialNumber: { fundId: fund.id, serialNumber } },
      create: {
        fundId: fund.id,
        serialNumber,
        account: fakeAddress(`${fund.id}:card:${n}`),
        number: Number(n),
      },
      update: {},
    });
  }

  for (const [i, name] of ["Test Grocery", "Test Bakery"].entries()) {
    await db.merchant.upsert({
      where: { fundId_name: { fundId: fund.id, name: `${name} ${slug}` } },
      create: {
        fundId: fund.id,
        name: `${name} ${slug}`,
        description: "Synthetic merchant for staging.",
        email: `shop${i + 1}.${slug}@example.org`,
        address: `${10 + i} Example Market`,
        postalCode: "0000",
        city: "Testville",
        status: i === 0 ? "ACTIVE" : "PENDING",
        position: i,
      },
      update: {},
    });
  }

  return { created };
}

export async function runSeed(db: Db, env: NodeJS.ProcessEnv): Promise<void> {
  checkSeedAllowed(env);

  const existing = await db.fund.findMany({ select: { id: true } });
  const foreign = foreignFundIds(existing.map((f) => f.id));
  if (foreign.length > 0) {
    throw new SeedRefused(
      `Refusing to seed: the database holds ${foreign.length} fund(s) the synthetic seed did not create. ` +
        "This is not a synthetic database; run the migration-only release command instead.",
    );
  }

  const appCredKey = env.APP_CRED_KEY ? parseHexKey("APP_CRED_KEY", env.APP_CRED_KEY) : null;
  if (!appCredKey) {
    console.log("APP_CRED_KEY is not set: funds are seeded without encrypted columns.");
  }
  const passwordHash = env.SEED_STAFF_PASSWORD
    ? await hashPassword(env.SEED_STAFF_PASSWORD)
    : null;

  await upsertUser(db, PLATFORM_ADMIN_EMAIL, "Test Platform Admin", passwordHash, "ADMIN");
  for (const fund of SEED_FUNDS) {
    const { created } = await seedFund(db, fund, appCredKey, passwordHash);
    console.log(`${created ? "created" : "kept   "} ${fund.domain} (${fund.id})`);
  }
  console.log(
    `Synthetic seed done: ${SEED_FUNDS.length} funds${passwordHash ? ", staff passwords set" : ""}.`,
  );
}

async function main(): Promise<number> {
  try {
    checkSeedAllowed(process.env);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }
  const db = new PrismaClient({
    adapter: new PrismaPg(pgTlsConfig(url, process.env.DATABASE_CA_CERT)),
  });
  try {
    await runSeed(db, process.env);
    return 0;
  } catch (e) {
    if (e instanceof SeedRefused) {
      console.error(e.message);
      return 2;
    }
    console.error(e instanceof Error ? e.message : e);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

// Run only as a program, not when a test imports the guards.
if (process.env.VITEST === undefined) {
  main().then((code) => {
    process.exitCode = code;
  });
}
