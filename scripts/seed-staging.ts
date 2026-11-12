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
// Guards, checked before anything is written:
//   1. SEED_SYNTHETIC_OK must be exactly "1", else it refuses (exit 2).
//   2. The database holds no fund and no user the seed did not create
//      (seeded funds have fixed ids, seeded users fixed example.org
//      addresses). If it does (someone created a fund or an account by hand
//      on staging, or this is not a synthetic database at all), the seed
//      SKIPS: it writes nothing, says so in one line and exits 0, so the
//      deploy goes on.
//   3. APP_CRED_KEY is required (exit 1 without it): every fund gets its
//      encrypted cells, none is seeded half.
//
// Idempotent: every row is found by a natural key and created only when
// missing, and a password is rewritten only when the stored hash does not
// verify it; a second run writes nothing. Encrypted columns are written
// once, under the APP_CRED_KEY of the first run, and never touched again, so
// a key rotation's re-encryption has real cells to walk (they hold a fake
// API key and a freshly generated, never-funded minter key).
//
// Passwords, both optional (unset = the account has no password; with email
// disabled on staging it then cannot sign in):
//   SEED_STAFF_PASSWORD  the seeded fund staff (OWNER / OPERATOR)
//   SEED_ADMIN_PASSWORD  the seeded platform admin (User.globalRole ADMIN)
//
// Works with the Citizen Pay client in mock mode (CITIZENPAY_API_BASE_URL
// unset): the funds carry a fake treasury id so the crons pick them up, and
// the mock answers for every call.

import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword, verifyPassword } from "better-auth/crypto";
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

/** Every address the seed creates a User for. */
export const SEED_USER_EMAILS = new Set([
  PLATFORM_ADMIN_EMAIL,
  ...SEED_FUNDS.flatMap((f) => staffFor(f).map((s) => s.email)),
]);

export function foreignUserEmails(existingEmails: string[]): string[] {
  return existingEmails.filter((email) => !SEED_USER_EMAILS.has(email));
}

// -----------------------------------------------------------------------------
// Seed
// -----------------------------------------------------------------------------

type Db = PrismaClient;

async function upsertUser(
  db: Db,
  email: string,
  name: string,
  password: string | null,
  globalRole: "USER" | "ADMIN" = "USER",
): Promise<string> {
  const user =
    (await db.user.findUnique({ where: { email }, select: { id: true } })) ??
    (await db.user.create({
      data: { email, name, emailVerified: true, globalRole },
      select: { id: true },
    }));
  if (password) {
    // Better Auth's credential account: accountId = the user id. Written
    // only when missing or when the stored hash does not verify `password`.
    const existing = await db.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
      select: { id: true, password: true },
    });
    if (!existing) {
      await db.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: await hashPassword(password),
        },
      });
    } else if (!existing.password || !(await verifyPassword({ hash: existing.password, password }))) {
      await db.account.update({
        where: { id: existing.id },
        data: { password: await hashPassword(password) },
      });
    }
  }
  return user.id;
}

async function seedFund(
  db: Db,
  fund: SeedFund,
  appCredKey: Buffer,
  staffPassword: string | null,
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
        citizenPayApiKeyId: fakeAddress(`${fund.id}:api-key`),
        citizenPayApiKeyEnc: encryptWith(appCredKey, `synthetic-api-key-${fund.id}`, "v1"),
        tokenMinterEoaAddress: privateKeyToAccount(minterKey).address,
        tokenMinterPrivateKeyEnc: encryptWith(appCredKey, minterKey, "v1"),
        subscriptionWaivedAt: fund.waived ? new Date() : null,
        subscriptionWaiverReason: fund.waived ? "Synthetic staging fund" : null,
        billingEmail: `billing.${fund.id.replace("seed-synthetic-fund-", "")}@example.org`,
      },
    });
  }

  for (const s of staffFor(fund)) {
    const userId = await upsertUser(db, s.email, s.name, staffPassword);
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

export type SeedOutcome = "seeded" | "skipped";

export async function runSeed(db: Db, env: NodeJS.ProcessEnv): Promise<SeedOutcome> {
  checkSeedAllowed(env);
  if (!env.APP_CRED_KEY) {
    throw new Error("APP_CRED_KEY is not set: the seed needs it to write the funds' encrypted cells.");
  }
  const appCredKey = parseHexKey("APP_CRED_KEY", env.APP_CRED_KEY);

  const [funds, users] = await Promise.all([
    db.fund.findMany({ select: { id: true } }),
    db.user.findMany({ select: { email: true } }),
  ]);
  const foreignFunds = foreignFundIds(funds.map((f) => f.id));
  const foreignUsers = foreignUserEmails(users.map((u) => u.email));
  if (foreignFunds.length > 0 || foreignUsers.length > 0) {
    console.log(
      `Synthetic seed skipped: the database holds ${foreignFunds.length} fund(s) and ` +
        `${foreignUsers.length} user(s) the seed did not create. Nothing written.`,
    );
    return "skipped";
  }

  const staffPassword = env.SEED_STAFF_PASSWORD || null;
  const adminPassword = env.SEED_ADMIN_PASSWORD || null;

  await upsertUser(db, PLATFORM_ADMIN_EMAIL, "Test Platform Admin", adminPassword, "ADMIN");
  for (const fund of SEED_FUNDS) {
    const { created } = await seedFund(db, fund, appCredKey, staffPassword);
    console.log(`${created ? "created" : "kept   "} ${fund.domain} (${fund.id})`);
  }
  console.log(
    `Synthetic seed done: ${SEED_FUNDS.length} funds` +
      `${staffPassword ? ", staff password set" : ""}${adminPassword ? ", admin password set" : ""}.`,
  );
  return "seeded";
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
  let db: PrismaClient;
  try {
    db = new PrismaClient({
      adapter: new PrismaPg(pgTlsConfig(url, process.env.DATABASE_CA_CERT)),
    });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
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
