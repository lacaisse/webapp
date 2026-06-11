// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cleanup after the member-import card-provisioning bug + member re-import:
//
//   1. Delete JUNK CARDS — cards the old import wrongly provisioned from a
//      card-number column. Signature: a digits-only serialNumber that equals
//      ANOTHER card's per-fund `number` (e.g. junk card #248 with serial
//      "205" shadowing the real card #205). Deleting a card SetNull's
//      BankTransaction.cardId and Member.primaryCardId — no history is lost.
//      NOTE: these cards were also created at CitizenPay; CP-side cleanup is
//      a separate, out-of-band step.
//
//   2. Wipe ALL MEMBERS of the fund (for a clean re-import). Cascades delete
//      Referrals / EmailVerifications / LinkedBankAccounts; Cards,
//      BankTransactions, TokenOperations and Emails are kept but unlinked
//      (memberId set to null).
//
// Usage:
//   npx tsx scripts/cleanup-junk-cards-members.ts                       # list funds
//   npx tsx scripts/cleanup-junk-cards-members.ts <domain|id>           # dry run
//   npx tsx scripts/cleanup-junk-cards-members.ts <domain|id> --confirm # apply

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

  if (!target) {
    const funds = await prisma.fund.findMany({
      select: {
        id: true,
        domain: true,
        name: true,
        _count: { select: { members: true, cards: true } },
      },
      orderBy: { domain: "asc" },
    });
    console.log("Funds:\n");
    for (const f of funds)
      console.log(
        `  ${f.domain}  —  ${f.name}  (members: ${f._count.members}, cards: ${f._count.cards})  [${f.id}]`,
      );
    console.log(`\nRe-run with a domain or id to dry-run, then add --confirm.`);
    return;
  }

  const fund = await prisma.fund.findFirst({
    where: { OR: [{ domain: target }, { id: target }] },
    select: { id: true, domain: true, name: true },
  });
  if (!fund) {
    console.error(`No fund matched "${target}".`);
    process.exit(1);
  }
  console.log(`Fund: ${fund.domain} — ${fund.name} [${fund.id}]\n`);

  // --- 1. Junk cards ---------------------------------------------------------
  const cards = await prisma.card.findMany({
    where: { fundId: fund.id },
    select: {
      id: true,
      serialNumber: true,
      number: true,
      memberId: true,
      balance: true,
      createdAt: true,
    },
  });
  const numbersInFund = new Set(
    cards.map((c) => c.number).filter((n): n is number => n != null),
  );
  const junk = cards.filter(
    (c) =>
      c.serialNumber &&
      /^\d+$/.test(c.serialNumber) &&
      numbersInFund.has(Number(c.serialNumber)) &&
      // its "serial" shadows ANOTHER card's number, not its own
      Number(c.serialNumber) !== c.number,
  );
  const junkIds = junk.map((c) => c.id);

  const junkNumbers = junk
    .map((c) => c.number)
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  const junkWithBalance = junk.filter((c) => Number(c.balance) > 0);
  const txOnJunk = junkIds.length
    ? await prisma.bankTransaction.count({
        where: { cardId: { in: junkIds } },
      })
    : 0;

  console.log(`  Cards total:                    ${cards.length}`);
  console.log(`  Junk cards to DELETE:           ${junk.length}`);
  if (junk.length > 0) {
    console.log(
      `    number range:                 #${junkNumbers[0]}…#${junkNumbers[junkNumbers.length - 1]}`,
    );
    console.log(
      `    sample serials:               ${junk.slice(0, 5).map((c) => `"${c.serialNumber}"`).join(", ")}`,
    );
    console.log(`    with non-zero balance:        ${junkWithBalance.length}`);
    console.log(`    bank transactions unlinked:   ${txOnJunk} (cardId → null)`);
  }
  if (junkWithBalance.length > 0) {
    console.log(
      `\n  ⚠ ${junkWithBalance.length} junk card(s) carry a balance — check on CitizenPay before deleting.`,
    );
  }

  // --- 2. Members ------------------------------------------------------------
  const where = { fundId: fund.id };
  const [members, linkedAccts, referrals, txLinked, emailsLinked] =
    await Promise.all([
      prisma.member.count({ where }),
      prisma.linkedBankAccount.count({ where }),
      prisma.referral.count({ where }),
      prisma.bankTransaction.count({
        where: { fundId: fund.id, memberId: { not: null } },
      }),
      prisma.email.count({ where: { fundId: fund.id, memberId: { not: null } } }),
    ]);

  console.log(`\n  Members to DELETE:              ${members}`);
  console.log(`  → Referrals deleted (cascade):        ${referrals}`);
  console.log(`  → LinkedBankAccounts deleted (csc):   ${linkedAccts}`);
  console.log(`  BankTransactions unlinked (kept):     ${txLinked}`);
  console.log(`  Emails unlinked (kept):               ${emailsLinked}`);
  console.log(`  Cards unlinked (kept, minus junk):    ${cards.filter((c) => c.memberId && !junkIds.includes(c.id)).length}`);

  if (junk.length === 0 && members === 0) {
    console.log(`\nNothing to clean up.`);
    return;
  }
  if (!confirm) {
    console.log(`\nDRY RUN — nothing changed. Add --confirm to apply.`);
    return;
  }

  // Cards first (SetNull releases Member.primaryCardId), then members.
  if (junkIds.length > 0) {
    const del = await prisma.card.deleteMany({ where: { id: { in: junkIds } } });
    console.log(`\nDeleted ${del.count} junk card(s).`);
  }
  if (members > 0) {
    const del = await prisma.member.deleteMany({ where });
    console.log(`Deleted ${del.count} member(s).`);
  }

  const [cardsLeft, membersLeft] = await Promise.all([
    prisma.card.count({ where }),
    prisma.member.count({ where }),
  ]);
  console.log(`\nRemaining: ${cardsLeft} cards, ${membersLeft} members.`);
  console.log(
    `Reminder: the junk cards also exist at CitizenPay — clean those up on CP's side.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
