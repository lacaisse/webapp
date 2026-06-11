// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bulk-delete every Member of a single fund (dev data reset).
//
// Usage:
//   npx tsx scripts/clear-fund-members.ts                      # list funds
//   npx tsx scripts/clear-fund-members.ts <domain|id>          # dry run (counts only)
//   npx tsx scripts/clear-fund-members.ts <domain|id> --confirm  # actually delete
//
// "Members only": deleting a Member cascades to its Referrals,
// EmailVerifications and LinkedBankAccounts, and sets memberId to null on the
// fund's Cards, BankTransactions, TokenOperations and Emails (those rows are
// kept, just unlinked). See prisma/schema.prisma onDelete rules.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const target = args.find((a) => !a.startsWith("--"));

  // No fund given → list funds so the caller can pick one.
  if (!target) {
    const funds = await prisma.fund.findMany({
      select: {
        id: true,
        domain: true,
        name: true,
        _count: { select: { members: true } },
      },
      orderBy: { domain: "asc" },
    });
    console.log(`Funds (${funds.length}):\n`);
    for (const f of funds) {
      console.log(
        `  ${f.domain}  —  ${f.name}  (members: ${f._count.members})  [${f.id}]`,
      );
    }
    console.log(
      `\nRe-run with a domain or id to dry-run, then add --confirm to delete.`,
    );
    return;
  }

  const fund = await prisma.fund.findFirst({
    where: { OR: [{ domain: target }, { id: target }] },
    select: { id: true, domain: true, name: true },
  });
  if (!fund) {
    console.error(`No fund matched "${target}" (tried domain and id).`);
    process.exit(1);
  }

  const where = { fundId: fund.id };
  const [members, cards, bankTx, tokenOps, emails, linkedAccts, referrals] =
    await Promise.all([
      prisma.member.count({ where }),
      prisma.card.count({ where: { fundId: fund.id, memberId: { not: null } } }),
      prisma.bankTransaction.count({
        where: { fundId: fund.id, memberId: { not: null } },
      }),
      prisma.tokenOperation.count({
        where: { fundId: fund.id, memberId: { not: null } },
      }),
      prisma.email.count({
        where: { fundId: fund.id, memberId: { not: null } },
      }),
      prisma.linkedBankAccount.count({ where: { fundId: fund.id } }),
      prisma.referral.count({ where: { fundId: fund.id } }),
    ]);

  console.log(`Fund: ${fund.domain} — ${fund.name} [${fund.id}]\n`);
  console.log(`  Members to DELETE:            ${members}`);
  console.log(`  → Referrals deleted (cascade):       ${referrals}`);
  console.log(`  → LinkedBankAccounts deleted (csc):  ${linkedAccts}`);
  console.log(`  Cards unlinked (kept):        ${cards}`);
  console.log(`  BankTransactions unlinked:    ${bankTx}`);
  console.log(`  TokenOperations unlinked:     ${tokenOps}`);
  console.log(`  Emails unlinked:              ${emails}`);

  if (members === 0) {
    console.log(`\nNothing to delete.`);
    return;
  }

  if (!confirm) {
    console.log(`\nDRY RUN — no rows deleted. Add --confirm to proceed.`);
    return;
  }

  const result = await prisma.member.deleteMany({ where });
  console.log(`\nDeleted ${result.count} member(s) from ${fund.domain}.`);

  const remaining = await prisma.member.count({ where });
  console.log(`Members remaining for this fund: ${remaining}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
