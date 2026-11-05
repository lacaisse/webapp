// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Waive the La Caisse hosting subscription for a fund — hosting is free, the
// setup checklist's subscription step is done without an acceptance. The
// in-app way is a waiver code (apex /admin/waivers, redeemed by the fund's
// OWNER on Settings → Subscription); this script is for the cases without a
// code: grandfathering the funds that existed before the subscription step
// shipped, or a one-off agreed by email.
//
// Usage:
//   npx tsx scripts/waive-subscription.ts                                  # list funds + hosting state
//   npx tsx scripts/waive-subscription.ts <domain|id> --reason "…"          # dry run for one fund
//   npx tsx scripts/waive-subscription.ts <domain|id> --reason "…" --apply  # write it
//   npx tsx scripts/waive-subscription.ts --all --reason "…" [--apply]      # every fund that neither
//                                                                           # accepted nor was waived
//
// The reason is shown to the fund on Settings → Subscription ("Reason: …"),
// so write it for them: "Founding fund — free hosting", not a ticket number.
// A fund that already accepted (paying) or was already waived is left alone
// and reported. Nothing here ever clears a waiver or an acceptance.

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

const SELECT = {
  id: true,
  domain: true,
  name: true,
  subscriptionAcceptedAt: true,
  subscriptionWaivedAt: true,
  subscriptionWaiverReason: true,
} as const;

type Row = {
  id: string;
  domain: string;
  name: string;
  subscriptionAcceptedAt: Date | null;
  subscriptionWaivedAt: Date | null;
  subscriptionWaiverReason: string | null;
};

function hostingState(fund: Row): string {
  if (fund.subscriptionAcceptedAt) {
    return `accepted ${fund.subscriptionAcceptedAt.toISOString().slice(0, 10)}`;
  }
  if (fund.subscriptionWaivedAt) {
    return `waived ${fund.subscriptionWaivedAt.toISOString().slice(0, 10)} (${fund.subscriptionWaiverReason ?? "no reason"})`;
  }
  return "unsettled";
}

function readReason(args: string[]): string | null {
  const i = args.indexOf("--reason");
  if (i === -1) return null;
  const value = args[i + 1]?.trim();
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const reason = readReason(args);
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--reason");

  if (!target && !all) {
    const funds = await prisma.fund.findMany({ select: SELECT, orderBy: { domain: "asc" } });
    console.log(`Funds (${funds.length}):\n`);
    for (const f of funds) {
      console.log(`  ${f.domain}  —  ${f.name}  [${hostingState(f)}]`);
    }
    console.log(
      `\nRe-run with a domain or id (or --all) and --reason "…" to dry-run, then add --apply to write.`,
    );
    return;
  }

  if (!reason) {
    console.error(`--reason "…" is required: it is shown to the fund as why hosting is free.`);
    process.exit(1);
  }

  const candidates: Row[] = all
    ? await prisma.fund.findMany({
        select: SELECT,
        where: { subscriptionAcceptedAt: null, subscriptionWaivedAt: null },
        orderBy: { domain: "asc" },
      })
    : await prisma.fund.findMany({
        select: SELECT,
        where: { OR: [{ domain: target }, { id: target }] },
      });

  if (candidates.length === 0) {
    console.error(all ? "No unsettled fund." : `No fund matches "${target}".`);
    process.exit(all ? 0 : 1);
  }

  let written = 0;
  for (const fund of candidates) {
    if (fund.subscriptionAcceptedAt || fund.subscriptionWaivedAt) {
      console.log(`  skip   ${fund.domain}  [${hostingState(fund)}]`);
      continue;
    }
    if (!apply) {
      console.log(`  would waive  ${fund.domain}  —  ${fund.name}  (reason: ${reason})`);
      continue;
    }
    // Conditional on the fund still being unsettled, like the in-app writes:
    // an OWNER accepting or redeeming at the same moment wins, never both.
    const { count } = await prisma.fund.updateMany({
      where: { id: fund.id, subscriptionAcceptedAt: null, subscriptionWaivedAt: null },
      data: { subscriptionWaivedAt: new Date(), subscriptionWaiverReason: reason },
    });
    if (count === 1) {
      written++;
      console.log(`  waived ${fund.domain}  —  ${fund.name}  (reason: ${reason})`);
    } else {
      console.log(`  skip   ${fund.domain}  [settled meanwhile]`);
    }
  }

  if (!apply) {
    console.log(`\nDry run — add --apply to write.`);
  } else {
    console.log(`\nDone: ${written} fund(s) waived.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
