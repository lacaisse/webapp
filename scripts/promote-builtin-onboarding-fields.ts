// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Repair (issue #178): promote a fund's CUSTOM onboarding questions to the
// BUILT-IN member fields whose names they shadow, and move the answers already
// collected under them out of `applicationData` and into the typed Member
// columns.
//
// The bug it fixes: a fund configured its signup form with ordinary custom
// questions keyed `address` / `postalcode` / `city`. Those look right on the
// public form, but `OnboardingField.builtinKey` is what decides where an answer
// is written (services/member/actions.ts), and it was NULL — so every answer
// landed in the `applicationData` JSON blob while `Member.address` /
// `postalCode` / `city` stayed NULL. The admin profile header renders the typed
// columns, and so does formatMemberAddress for the {address} placeholder on
// card-assigned emails, so both showed an empty address even though the
// applicant had filled the form in. Setting `builtinKey` is the whole fix for
// new signups; this script also repairs the answers already collected.
//
// Why a script and not a migration: migration
// 20260727150000_onboarding_builtin_member_fields deliberately left funds with
// a pre-existing custom `address` field alone — "that is the whole reason this
// is an explicit column rather than inferring built-in-ness from the key name".
// Reversing that for one fund is an operator decision that wants a dry run, not
// a blanket rule that runs on every environment forever.
//
// Scope and policy:
//   - Only ACTIVE (non-archived) MEMBER fields whose key matches a built-in
//     registry key case-insensitively. Archived questions keep their history.
//   - `tierId` is deliberately NEVER promoted — a tier picker's stored answer
//     is an admin-authored option value, not an AllocationTier id, so mapping
//     it needs a product decision. Candidates are reported, never touched.
//   - Conflict policy: if the typed column already holds a value that differs
//     from the JSON answer, the TYPED COLUMN WINS. The JSON key is kept and the
//     row reported — an admin-curated column (e.g. from CSV import) is never
//     overwritten by an answer of unknown provenance.
//   - Idempotent: a promoted field no longer matches (builtinKey is set), and a
//     member whose column already equals the JSON value just loses the key.
//
// Usage:
//   npx tsx scripts/promote-builtin-onboarding-fields.ts                       # list funds
//   npx tsx scripts/promote-builtin-onboarding-fields.ts <domain|id>           # dry run
//   npx tsx scripts/promote-builtin-onboarding-fields.ts <domain|id> --confirm # apply

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "../services/db/generated/client";
import {
  MEMBER_BUILTIN_FIELDS,
  coerceBuiltinValue,
  type MemberBuiltinKey,
} from "../services/member/builtin-fields";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// The Member column each promotable built-in writes to. `tierId` is absent on
// purpose (see the header); spelling the mapping out means a future registry
// entry whose column differs is a type error here, not a silent no-op.
const COLUMN = {
  address: "address",
  postalCode: "postalCode",
  city: "city",
} as const satisfies Partial<Record<MemberBuiltinKey, string>>;

type PromotableKey = keyof typeof COLUMN;

const PROMOTABLE = MEMBER_BUILTIN_FIELDS.filter(
  (f): f is (typeof MEMBER_BUILTIN_FIELDS)[number] & { key: PromotableKey } =>
    f.key in COLUMN,
);
const SKIPPED = MEMBER_BUILTIN_FIELDS.filter((f) => !(f.key in COLUMN));

type MemberPlan =
  | { kind: "move"; memberId: string; label: string; value: string }
  | { kind: "drop"; memberId: string; label: string; reason: string }
  | {
      kind: "conflict";
      memberId: string;
      label: string;
      json: string;
      column: string;
    }
  | { kind: "uncoercible"; memberId: string; label: string; raw: string };

type FieldPlan = {
  fieldId: string;
  oldKey: string;
  newKey: PromotableKey;
  oldType: string;
  newType: "TEXT" | "SELECT";
  members: MemberPlan[];
};

type MemberRow = {
  id: string;
  firstName: string;
  lastName: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  applicationData: Prisma.JsonValue;
};

function shadows(key: string, builtinKey: string): boolean {
  return key.toLowerCase() === builtinKey.toLowerCase();
}

function blobOf(row: { applicationData: Prisma.JsonValue }): Record<string, unknown> {
  const d = row.applicationData;
  return d && typeof d === "object" && !Array.isArray(d)
    ? (d as Record<string, unknown>)
    : {};
}

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
        _count: { select: { members: true } },
        onboardingFields: {
          where: { target: "MEMBER", archivedAt: null, builtinKey: null },
          select: { key: true },
        },
      },
      orderBy: { domain: "asc" },
    });
    console.log("Funds:\n");
    for (const f of funds) {
      const shadowing = f.onboardingFields.filter((o) =>
        PROMOTABLE.some((b) => shadows(o.key, b.key)),
      );
      const note =
        shadowing.length > 0
          ? `  ⚠ shadowing: ${shadowing.map((o) => o.key).join(", ")}`
          : "";
      console.log(
        `  ${f.domain}  —  ${f.name}  (members: ${f._count.members})  [${f.id}]${note}`,
      );
    }
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

  // Every query below is scoped by fundId — this script must never read or
  // write another fund's rows.
  const activeFields = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
    select: { id: true, key: true, type: true, builtinKey: true },
    orderBy: { position: "asc" },
  });
  const activeKeys = new Set(activeFields.map((f) => f.key));

  const skippedHere = activeFields.filter(
    (f) => f.builtinKey === null && SKIPPED.some((b) => shadows(f.key, b.key)),
  );
  const candidates = activeFields.filter(
    (f) => f.builtinKey === null && PROMOTABLE.some((b) => shadows(f.key, b.key)),
  );

  if (candidates.length === 0) {
    console.log("  No custom field shadows a promotable built-in.");
    reportSkipped(skippedHere);
    console.log(`\nNothing to promote.`);
    return;
  }

  // One pass over the fund's answered members, reused for every candidate.
  const members: MemberRow[] = await prisma.member.findMany({
    where: { fundId: fund.id, applicationData: { not: Prisma.DbNull } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      address: true,
      postalCode: true,
      city: true,
      applicationData: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const plans: FieldPlan[] = [];
  const blocked: string[] = [];

  for (const field of candidates) {
    const builtin = PROMOTABLE.find((b) => shadows(field.key, b.key))!;
    const newKey = builtin.key;

    // A rename would collide with a different active field already holding the
    // canonical key. Leave both alone and let a human decide which to keep.
    if (field.key !== newKey && activeKeys.has(newKey)) {
      blocked.push(
        `"${field.key}" → "${newKey}": this fund already has an active field keyed "${newKey}"`,
      );
      continue;
    }

    const column = COLUMN[newKey];
    const memberPlans: MemberPlan[] = [];

    for (const m of members) {
      const blob = blobOf(m);
      if (!(field.key in blob)) continue;
      const label = `${m.firstName} ${m.lastName}`.trim();
      const coerced = coerceBuiltinValue(newKey, blob[field.key]);

      if (!coerced.ok) {
        memberPlans.push({
          kind: "uncoercible",
          memberId: m.id,
          label,
          raw: JSON.stringify(blob[field.key]),
        });
      } else if (coerced.value === null) {
        memberPlans.push({
          kind: "drop",
          memberId: m.id,
          label,
          reason: "blank answer",
        });
      } else if (m[column] === null) {
        memberPlans.push({
          kind: "move",
          memberId: m.id,
          label,
          value: coerced.value,
        });
      } else if (m[column] === coerced.value) {
        memberPlans.push({
          kind: "drop",
          memberId: m.id,
          label,
          reason: "column already matches",
        });
      } else {
        memberPlans.push({
          kind: "conflict",
          memberId: m.id,
          label,
          json: coerced.value,
          column: m[column]!,
        });
      }
    }

    plans.push({
      fieldId: field.id,
      oldKey: field.key,
      newKey,
      oldType: field.type,
      newType: builtin.type,
      members: memberPlans,
    });
  }

  // --- Report ---------------------------------------------------------------
  for (const p of plans) {
    const rename = p.oldKey === p.newKey ? "" : `  (rename from "${p.oldKey}")`;
    const retype =
      p.oldType === p.newType ? "" : `  [type ${p.oldType} → ${p.newType}]`;
    console.log(`  Field "${p.newKey}"${rename}${retype}`);
    console.log(`    builtinKey: null → "${p.newKey}", config → null`);

    const of = (k: MemberPlan["kind"]) => p.members.filter((m) => m.kind === k);
    const moves = of("move");
    console.log(
      `    answers to move into Member.${COLUMN[p.newKey]}: ${moves.length}`,
    );
    for (const m of moves) {
      if (m.kind !== "move") continue;
      console.log(`      · ${m.label} → ${JSON.stringify(m.value)}`);
    }

    const drops = of("drop");
    if (drops.length > 0) {
      console.log(`    JSON keys dropped without a write: ${drops.length}`);
      for (const m of drops) {
        if (m.kind !== "drop") continue;
        console.log(`      · ${m.label} (${m.reason})`);
      }
    }

    const conflicts = of("conflict");
    if (conflicts.length > 0) {
      console.log(
        `    ⚠ CONFLICTS (typed column wins, JSON key kept): ${conflicts.length}`,
      );
      for (const m of conflicts) {
        if (m.kind !== "conflict") continue;
        console.log(
          `      · ${m.label}: column ${JSON.stringify(m.column)} vs answer ${JSON.stringify(m.json)}`,
        );
      }
    }

    const bad = of("uncoercible");
    if (bad.length > 0) {
      console.log(`    ⚠ UNCOERCIBLE (left in applicationData): ${bad.length}`);
      for (const m of bad) {
        if (m.kind !== "uncoercible") continue;
        console.log(`      · ${m.label}: ${m.raw}`);
      }
    }
    console.log("");
  }

  if (blocked.length > 0) {
    console.log(`  ⚠ BLOCKED — not promoted:`);
    for (const b of blocked) console.log(`      · ${b}`);
    console.log("");
  }
  reportSkipped(skippedHere);

  if (!confirm) {
    console.log(`\nDRY RUN — nothing changed. Add --confirm to apply.`);
    return;
  }

  // --- Apply ----------------------------------------------------------------
  // One transaction: member answers first, the field definition LAST, so an
  // abort mid-way leaves the field still custom — i.e. exactly today's
  // behaviour — rather than a promoted field whose answers never moved.
  let moved = 0;
  let dropped = 0;
  await prisma.$transaction(async (tx) => {
    for (const p of plans) {
      const column = COLUMN[p.newKey];
      for (const m of p.members) {
        if (m.kind === "conflict" || m.kind === "uncoercible") continue;
        const row = await tx.member.findFirst({
          where: { id: m.memberId, fundId: fund.id },
          select: { applicationData: true },
        });
        if (!row) continue;
        const blob = { ...blobOf(row) };
        delete blob[p.oldKey];
        await tx.member.update({
          where: { id: m.memberId },
          data: {
            ...(m.kind === "move" ? { [column]: m.value } : {}),
            applicationData:
              Object.keys(blob).length > 0
                ? (blob as Prisma.InputJsonValue)
                : Prisma.JsonNull,
          },
        });
        if (m.kind === "move") moved++;
        else dropped++;
      }
      await tx.onboardingField.update({
        where: { id: p.fieldId },
        data: {
          key: p.newKey,
          builtinKey: p.newKey,
          type: p.newType,
          // Built-ins never carry admin-authored options — mirrors what
          // updateOnboardingFieldAction forces for a built-in.
          config: Prisma.JsonNull,
        },
      });
    }
  });

  console.log(
    `\nPromoted ${plans.length} field(s); moved ${moved} answer(s) into typed columns, dropped ${dropped} redundant key(s).`,
  );
  console.log(
    `Verify: the member detail header and the {address} placeholder on card-assigned emails should now render the address.`,
  );
}

function reportSkipped(skipped: { key: string }[]): void {
  if (skipped.length === 0) return;
  console.log(
    `  ℹ Not promoted (needs a product decision — see the header): ${skipped
      .map((f) => `"${f.key}"`)
      .join(", ")}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
