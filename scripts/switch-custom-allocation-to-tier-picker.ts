// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Repair (issue #186): replace a fund's hand-rolled "allocation" SELECT on the
// signup form with the builtin tier picker (#157), and hide the tiers that
// only admins may assign.
//
// The bug it fixes: La CLASS configured a custom SELECT keyed `allocation`
// with options value1/value2/value3 labelled 75€/150€/225€. Those stored
// values have no relationship to AllocationTier ids, so an applicant's choice
// never reached Member.tierId — members arrived tierless and an admin had to
// assign one manually, unaware the applicant already chose.
//
// Product decisions from La CLASS (issue #186 comments, 2026-08-18):
//   - Applicants DO pick their own tier at signup.
//   - 75 € = Basse, 150 € = Standard, 225 € = Haute.
//   - "Maison Medicale" is admin-assigned only → hiddenAtSignup.
//   - Existing members keep whatever they have; this applies to new signups
//     only, so no back-assignment of historical `allocation` answers.
//
// What it does (one transaction):
//   1. Archives the active custom `allocation` field.
//   2. Creates the builtin `tierId` field in its place — same label, help
//      text, required flag, position and step, so the form looks unchanged.
//   3. Sets hiddenAtSignup on every tier named in --hide (repeatable).
//
// Safety rails:
//   - Aborts if any active field's visibleIf references the `allocation` key
//     (the reference would dangle after archival).
//   - Aborts if an active `tierId` field already exists (nothing to do), and
//     reports idempotently when `allocation` is already archived.
//   - Dry run by default; --confirm applies.
//
// Usage:
//   npx tsx scripts/switch-custom-allocation-to-tier-picker.ts <domain>                                  # dry run
//   npx tsx scripts/switch-custom-allocation-to-tier-picker.ts <domain> --hide "Maison Medicale" --confirm
//
// For #186 specifically:
//   npx tsx scripts/switch-custom-allocation-to-tier-picker.ts laclass.lacaisse.eu --hide "Maison Medicale" --confirm

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

const CUSTOM_FIELD_KEY = "allocation";

function parseArgs(argv: string[]) {
  const rest = argv.slice(2);
  const confirm = rest.includes("--confirm");
  const hide: string[] = [];
  let domain: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--confirm") continue;
    if (a === "--hide") {
      const v = rest[++i];
      if (!v) {
        console.error("--hide needs a tier name");
        process.exit(1);
      }
      hide.push(v);
      continue;
    }
    if (domain) {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
    domain = a;
  }
  return { domain, hide, confirm };
}

async function main() {
  const { domain, hide, confirm } = parseArgs(process.argv);
  if (!domain) {
    console.error(
      "Usage: npx tsx scripts/switch-custom-allocation-to-tier-picker.ts <fund domain> [--hide <tier name>]... [--confirm]",
    );
    process.exit(1);
  }

  const fund = await prisma.fund.findUnique({
    where: { domain },
    select: { id: true, name: true, domain: true },
  });
  if (!fund) {
    console.error(`No fund with domain ${domain}`);
    process.exit(1);
  }
  console.log(`Fund: ${fund.name} (${fund.domain})`);

  // --- Current state ---------------------------------------------------------
  const allocationField = await prisma.onboardingField.findUnique({
    where: {
      fundId_target_key: {
        fundId: fund.id,
        target: "MEMBER",
        key: CUSTOM_FIELD_KEY,
      },
    },
  });
  const tierField = await prisma.onboardingField.findUnique({
    where: {
      fundId_target_key: { fundId: fund.id, target: "MEMBER", key: "tierId" },
    },
    select: { id: true, archivedAt: true },
  });
  const tiers = await prisma.allocationTier.findMany({
    where: { fundId: fund.id, archivedAt: null },
    orderBy: { position: "asc" },
    select: {
      id: true,
      name: true,
      allocationAmount: true,
      hiddenAtSignup: true,
    },
  });

  console.log(`\nLive tiers:`);
  for (const t of tiers) {
    console.log(
      `  - ${t.name} (${Number(t.allocationAmount)} €)` +
        (t.hiddenAtSignup ? " [already hidden at signup]" : ""),
    );
  }

  const toHide = tiers.filter(
    (t) => hide.includes(t.name) && !t.hiddenAtSignup,
  );
  const unknownHides = hide.filter((h) => !tiers.some((t) => t.name === h));
  if (unknownHides.length > 0) {
    console.error(
      `\nABORT: --hide names no live tier: ${unknownHides.join(", ")}`,
    );
    process.exit(1);
  }

  // visibleIf rules referencing the field we're about to archive would
  // silently stop matching (the key disappears from new submissions).
  const dependents = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
    select: { key: true, visibleIf: true },
  });
  const dangling = dependents.filter((f) => {
    const rule = f.visibleIf as { fieldKey?: string } | null;
    return rule?.fieldKey === CUSTOM_FIELD_KEY;
  });
  if (dangling.length > 0) {
    console.error(
      `\nABORT: active field(s) reference "${CUSTOM_FIELD_KEY}" via visibleIf: ` +
        dangling.map((f) => f.key).join(", ") +
        ". Re-point or remove those rules first.",
    );
    process.exit(1);
  }

  // --- Plan ------------------------------------------------------------------
  const archiveAllocation = allocationField && allocationField.archivedAt === null;
  const createTierField = !tierField || tierField.archivedAt !== null;

  if (!allocationField) {
    console.log(`\nNo "${CUSTOM_FIELD_KEY}" field exists for this fund.`);
  } else if (!archiveAllocation) {
    console.log(`\n"${CUSTOM_FIELD_KEY}" field is already archived.`);
  } else {
    console.log(
      `\nWill archive custom field "${CUSTOM_FIELD_KEY}" ` +
        `(label "${allocationField.label}", position ${allocationField.position}).`,
    );
  }

  if (tierField && tierField.archivedAt === null) {
    console.log(`An active builtin tierId field already exists — will not create another.`);
  } else if (createTierField && allocationField) {
    console.log(
      `Will ${tierField ? "re-activate" : "create"} builtin tierId field ` +
        `inheriting label/required/position/step from "${CUSTOM_FIELD_KEY}".`,
    );
  }

  if (toHide.length > 0) {
    console.log(
      `Will set hiddenAtSignup on: ${toHide.map((t) => t.name).join(", ")}`,
    );
  }

  const nothingToDo =
    !archiveAllocation &&
    !(createTierField && allocationField) &&
    toHide.length === 0;
  if (nothingToDo) {
    console.log(`\nNothing to do.`);
    return;
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing changed. Add --confirm to apply.`);
    return;
  }

  // --- Apply -----------------------------------------------------------------
  await prisma.$transaction(async (tx) => {
    if (archiveAllocation && allocationField) {
      await tx.onboardingField.update({
        where: { id: allocationField.id },
        data: { archivedAt: new Date() },
      });
    }
    if (createTierField && allocationField) {
      if (tierField) {
        // Archived leftover: re-activate it in the old field's slot.
        await tx.onboardingField.update({
          where: { id: tierField.id },
          data: {
            archivedAt: null,
            label: allocationField.label,
            helpText: allocationField.helpText,
            required: allocationField.required,
            position: allocationField.position,
            stepId: allocationField.stepId,
          },
        });
      } else {
        await tx.onboardingField.create({
          data: {
            fundId: fund.id,
            target: "MEMBER",
            key: "tierId",
            builtinKey: "tierId",
            type: "SELECT",
            label: allocationField.label,
            helpText: allocationField.helpText,
            required: allocationField.required,
            position: allocationField.position,
            stepId: allocationField.stepId,
          },
        });
      }
    }
    for (const t of toHide) {
      await tx.allocationTier.update({
        where: { id: t.id },
        data: { hiddenAtSignup: true },
      });
    }
  });

  console.log(`\nDone.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
