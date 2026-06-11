// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Repair: re-link a fund's INCOMING bank transactions to members after the
// member rows were deleted + re-imported (which nulled BankTransaction.memberId
// but left cardId, references and IBANs intact). DATA ONLY — sets memberId /
// cardId / matchMethod / matchedAt. It never mints, emails, or touches
// allocationPeriodId, so re-linking deposits in already-CLOSED periods is safe.
//
// Resolution precedence per transaction (first hit wins):
//   1. Reference → card serial → a member-linked card          (SERIAL)
//   2. Reference → structured communication → member-linked card (STRUCTURED_COMMUNICATION)
//   3. counterpartIban → learned LinkedBankAccount             (IBAN)
//   4. Name bridge: the referenced (now memberless) card's holderName uniquely
//      matches a current member                                (MANUAL)
//
// The name bridge exists because a delete + re-import can leave members on
// fresh cards (new serials/numbers) while the historical deposits still point
// at the old, now-memberless cards. Those old cards keep our own recorded
// `holderName`, so we reconnect through it — exact, accent-insensitive match,
// skipping any name that maps to more than one member.
//
// Usage:
//   npx tsx scripts/relink-bank-transactions.ts                       # list funds
//   npx tsx scripts/relink-bank-transactions.ts <domain|id>           # dry run
//   npx tsx scripts/relink-bank-transactions.ts <domain|id> --confirm # apply

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";
import {
  parseCardSerial,
  parseStructuredCommunication,
} from "../services/bank-sync/matching/parse";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

type Method = "SERIAL" | "STRUCTURED_COMMUNICATION" | "IBAN" | "MANUAL";
type Resolution = {
  memberId: string;
  // string → set this cardId; null → clear it; undefined → leave as-is.
  cardId?: string | null;
  method: Method;
  bucket: keyof typeof EMPTY_BUCKETS;
};

const EMPTY_BUCKETS = {
  serial: 0,
  structuredComm: 0,
  iban: 0,
  nameBridge: 0,
  ambiguousName: 0,
  unresolved: 0,
};

const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    const funds = await prisma.fund.findMany({
      select: { id: true, domain: true, name: true },
      orderBy: { domain: "asc" },
    });
    console.log("Funds:\n");
    for (const f of funds) console.log(`  ${f.domain}  —  ${f.name}  [${f.id}]`);
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

  // --- Lookups -------------------------------------------------------------
  const cards = await prisma.card.findMany({
    where: { fundId: fund.id },
    select: {
      id: true,
      memberId: true,
      serialNumber: true,
      number: true,
      holderName: true,
    },
  });
  const cardById = new Map(cards.map((c) => [c.id, c]));
  // serial/number → a card that currently has a member (for the live bridges).
  const serialToMemberCard = new Map<string, (typeof cards)[number]>();
  const numberToMemberCard = new Map<number, (typeof cards)[number]>();
  // serial/number → any card (to recover the referenced card's holderName).
  const serialToAnyCard = new Map<string, (typeof cards)[number]>();
  const numberToAnyCard = new Map<number, (typeof cards)[number]>();
  for (const c of cards) {
    if (c.serialNumber) {
      const k = c.serialNumber.toUpperCase();
      serialToAnyCard.set(k, c);
      if (c.memberId) serialToMemberCard.set(k, c);
    }
    if (c.number != null) {
      numberToAnyCard.set(c.number, c);
      if (c.memberId) numberToMemberCard.set(c.number, c);
    }
  }

  const memberByIban = new Map(
    (
      await prisma.linkedBankAccount.findMany({
        where: { fundId: fund.id },
        select: { iban: true, memberId: true },
      })
    ).map((l) => [l.iban, l.memberId]),
  );

  // Member name index. A name can map to several members (duplicates); we keep
  // them all and disambiguate at resolve time, preferring the one that's
  // actually set up for allocation (ACTIVE + primary card).
  const members = await prisma.member.findMany({
    where: { fundId: fund.id },
    select: { id: true, firstName: true, lastName: true, status: true, primaryCardId: true },
  });
  type NameCandidate = { id: string; allocatable: boolean };
  const nameToMembers = new Map<string, NameCandidate[]>();
  for (const m of members) {
    const k = normName(`${m.firstName}${m.lastName}`);
    if (!k) continue;
    const cand = { id: m.id, allocatable: m.status === "ACTIVE" && !!m.primaryCardId };
    (nameToMembers.get(k) ?? nameToMembers.set(k, []).get(k)!).push(cand);
  }
  // Resolve a name key to a single member: unique name, else the single
  // allocatable (ACTIVE + card) candidate. Returns null if still ambiguous.
  const memberForName = (key: string): string | null => {
    const cands = nameToMembers.get(key);
    if (!cands || cands.length === 0) return null;
    if (cands.length === 1) return cands[0].id;
    const allocatable = cands.filter((c) => c.allocatable);
    return allocatable.length === 1 ? allocatable[0].id : null;
  };

  const txs = await prisma.bankTransaction.findMany({
    where: { fundId: fund.id, direction: "INCOMING", memberId: null },
    select: {
      id: true,
      cardId: true,
      matchMethod: true,
      matchedAt: true,
      counterpartReference: true,
      remittanceInfo: true,
      counterpartIban: true,
    },
  });

  const resolve = (tx: (typeof txs)[number]): Resolution | null => {
    const refs: (string | null)[] = [tx.counterpartReference, tx.remittanceInfo];
    const serial = parseCardSerial(...refs);
    const num = parseStructuredCommunication(...refs);

    // 1/2. Reference resolves directly to a member-linked card.
    if (serial) {
      const c = serialToMemberCard.get(serial.toUpperCase());
      if (c?.memberId)
        return { memberId: c.memberId, cardId: c.id, method: "SERIAL", bucket: "serial" };
    }
    if (num != null) {
      const c = numberToMemberCard.get(num);
      if (c?.memberId)
        return {
          memberId: c.memberId,
          cardId: c.id,
          method: "STRUCTURED_COMMUNICATION",
          bucket: "structuredComm",
        };
    }
    // 3. IBAN → learned member.
    if (tx.counterpartIban) {
      const memberId = memberByIban.get(tx.counterpartIban);
      if (memberId)
        return { memberId, cardId: null, method: "IBAN", bucket: "iban" };
    }
    // 4. Name bridge through the referenced (memberless) card's holderName.
    const refCard =
      (tx.cardId ? cardById.get(tx.cardId) : undefined) ??
      (serial ? serialToAnyCard.get(serial.toUpperCase()) : undefined) ??
      (num != null ? numberToAnyCard.get(num) : undefined);
    if (refCard?.holderName?.trim()) {
      const memberId = memberForName(normName(refCard.holderName));
      if (memberId)
        return {
          memberId,
          // leave cardId as-is: the old card belongs to no member now.
          method: "MANUAL",
          bucket: "nameBridge",
        };
    }
    return null;
  };

  const buckets = { ...EMPTY_BUCKETS };
  const updates: { id: string; res: Resolution; matchedAt: Date | null }[] = [];
  for (const tx of txs) {
    const res = resolve(tx);
    if (!res) {
      // Distinguish ambiguous-name from genuinely unresolved for the report.
      const serial = parseCardSerial(tx.counterpartReference, tx.remittanceInfo);
      const num = parseStructuredCommunication(
        tx.counterpartReference,
        tx.remittanceInfo,
      );
      const refCard =
        (tx.cardId ? cardById.get(tx.cardId) : undefined) ??
        (serial ? serialToAnyCard.get(serial.toUpperCase()) : undefined) ??
        (num != null ? numberToAnyCard.get(num) : undefined);
      const cands = refCard?.holderName?.trim()
        ? nameToMembers.get(normName(refCard.holderName))
        : undefined;
      // Ambiguous = the name matched members but the tiebreaker couldn't pick one.
      if (cands && cands.length > 1) buckets.ambiguousName++;
      else buckets.unresolved++;
      continue;
    }
    buckets[res.bucket]++;
    updates.push({ id: tx.id, res, matchedAt: tx.matchedAt });
  }

  console.log(`Fund: ${fund.domain} — ${fund.name} [${fund.id}]\n`);
  console.log(`  Unlinked INCOMING transactions: ${txs.length}`);
  console.log(`  → SERIAL → member card:         ${buckets.serial}`);
  console.log(`  → STRUCTURED_COMM → member card:${buckets.structuredComm}`);
  console.log(`  → IBAN:                         ${buckets.iban}`);
  console.log(`  → name bridge (holderName):     ${buckets.nameBridge}`);
  console.log(`  → ambiguous name (skipped):     ${buckets.ambiguousName}`);
  console.log(`  → unresolved (left as-is):      ${buckets.unresolved}`);
  console.log(`  Total to re-link:               ${updates.length}`);

  if (updates.length === 0) {
    console.log(`\nNothing to re-link.`);
    return;
  }
  if (!confirm) {
    console.log(`\nDRY RUN — no rows changed. Add --confirm to apply.`);
    return;
  }

  let done = 0;
  for (const u of updates) {
    await prisma.bankTransaction.update({
      where: { id: u.id },
      data: {
        memberId: u.res.memberId,
        ...(u.res.cardId !== undefined ? { cardId: u.res.cardId } : {}),
        matchMethod: u.res.method,
        matchedAt: u.matchedAt ?? new Date(),
      },
    });
    done++;
  }
  console.log(`\nRe-linked ${done} transaction(s) for ${fund.domain}.`);
  const remaining = await prisma.bankTransaction.count({
    where: { fundId: fund.id, direction: "INCOMING", memberId: null },
  });
  console.log(`Still unlinked: ${remaining}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
