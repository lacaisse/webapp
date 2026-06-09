// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { nextCardNumber } from "@/services/card/numbering";
import { normalizeSerial } from "@/services/card/serial";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { parseCsv } from "@/services/csv/parse";
import { prisma } from "@/services/db/prisma";

import {
  MEMBER_IMPORT_FIELDS,
  type MemberImportField,
  type MemberImportMapping,
  type MemberImportResult,
} from "./import-config";
import { generatePaymentReference } from "./payment-reference";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const REFERENCE_RETRIES = 5;

// Bulk member import from a CSV with headers. The admin maps each built-in
// field to a column (firstName/lastName/email required). On a duplicate email
// the existing member is updated with the mapped values; otherwise a new
// INVITED member is created. A mapped IBAN is stored and learned for
// auto-matching; a mapped serial links an existing unattached card (sets it
// primary + marks the member active), reporting serials with no such card.
export async function importMembersAction(input: {
  csv: string;
  mapping: MemberImportMapping;
  // Fixed values applied to every row for fields NOT mapped to a column
  // (e.g. assign one tier to the whole import). Ignored for a field that is
  // also column-mapped (the column wins).
  defaults?: MemberImportMapping;
}): Promise<MemberImportResult> {
  const t = await getTranslations("members.admin.import");
  const { fund } = await requireFundRole("ADMIN");
  const defaults = input.defaults ?? {};

  const required = MEMBER_IMPORT_FIELDS.filter((f) => f.required).map(
    (f) => f.key,
  );
  if (required.some((key) => !input.mapping[key])) {
    return { error: t("errors.missingRequiredMapping") };
  }

  const { headers, rows } = parseCsv(input.csv);
  const colIndex: Partial<Record<MemberImportField, number>> = {};
  for (const f of MEMBER_IMPORT_FIELDS) {
    const header = input.mapping[f.key];
    if (!header) continue;
    const idx = headers.indexOf(header);
    if (idx === -1) return { error: t("errors.columnMissing") };
    colIndex[f.key] = idx;
  }
  if (rows.length === 0) return { error: t("errors.empty") };

  // Tier name → id (case-insensitive), if tier is mapped or set as a default.
  const tierByName = new Map<string, string>();
  if (colIndex.tier !== undefined || defaults.tier) {
    const tiers = await prisma.allocationTier.findMany({
      where: { fundId: fund.id },
      select: { id: true, name: true },
    });
    for (const tier of tiers) tierByName.set(tier.name.toLowerCase(), tier.id);
  }

  let created = 0;
  let updated = 0;
  let cardsLinked = 0;
  const skipped: { row: number; reason: string }[] = [];
  const serialsNotFound: string[] = [];
  // Serials with no local card yet — provisioned at CP in one bulk call after
  // the row loop (deduped: first member to reference a serial wins it).
  const toProvision: {
    serial: string;
    memberId: string;
    firstName: string;
    lastName: string;
  }[] = [];
  const provisionSeen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-based + header row, for human-readable reporting
    // Value for a field: the mapped column's cell, else the fixed default.
    const valueFor = (key: MemberImportField): string => {
      const idx = colIndex[key];
      if (idx !== undefined) return (row[idx] ?? "").trim();
      return (defaults[key] ?? "").trim();
    };

    const firstName = valueFor("firstName");
    const lastName = valueFor("lastName");
    const email = valueFor("email").toLowerCase();
    if (!firstName || !lastName) {
      skipped.push({ row: rowNum, reason: t("skip.missingName") });
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      skipped.push({ row: rowNum, reason: t("skip.invalidEmail") });
      continue;
    }

    // Optional scalar fields — only overwrite when mapped AND non-empty.
    const optional: Record<string, string> = {};
    for (const key of ["phone", "address", "postalCode", "city", "notes"] as const) {
      const v = valueFor(key);
      if (v) optional[key] = v;
    }
    const iban = valueFor("iban") || null;
    if (iban) optional.iban = iban;

    const household: Record<string, number> = {};
    for (const key of ["householdAdults", "householdChildren"] as const) {
      const raw = valueFor(key);
      if (raw === "") continue;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0) household[key] = n;
    }

    const tierName = valueFor("tier");
    const tierId = tierName ? tierByName.get(tierName.toLowerCase()) : undefined;

    try {
      const existing = await prisma.member.findUnique({
        where: { fundId_email: { fundId: fund.id, email } },
        select: { id: true },
      });

      let memberId: string;
      if (existing) {
        await prisma.member.update({
          where: { id: existing.id },
          data: {
            firstName,
            lastName,
            ...optional,
            ...household,
            ...(tierId ? { tierId } : {}),
          },
        });
        memberId = existing.id;
        updated++;
      } else {
        memberId = await createMember({
          fundId: fund.id,
          email,
          firstName,
          lastName,
          optional,
          household,
          tierId,
        });
        created++;
      }

      // Learn the IBAN for auto-matching future deposits.
      if (iban) {
        await prisma.linkedBankAccount.upsert({
          where: { fundId_iban: { fundId: fund.id, iban } },
          create: {
            fundId: fund.id,
            iban,
            memberId,
            source: "ONBOARDING",
          },
          update: { memberId },
        });
      }

      // Serial → card. Link an existing unattached (or already-own) card now;
      // a serial with no local card is queued for bulk provisioning; a serial
      // owned by a different member is a conflict (reported, not stolen).
      const serial = normalizeSerial(valueFor("serial"));
      if (serial) {
        const card = await prisma.card.findFirst({
          where: {
            fundId: fund.id,
            serialNumber: { equals: serial, mode: "insensitive" },
          },
          select: { id: true, memberId: true },
        });
        if (card && (card.memberId === null || card.memberId === memberId)) {
          await linkCardToMember(card.id, memberId, { firstName, lastName });
          cardsLinked++;
        } else if (card) {
          serialsNotFound.push(serial); // attached to another member
        } else if (!provisionSeen.has(serial)) {
          provisionSeen.add(serial);
          toProvision.push({ serial, memberId, firstName, lastName });
        }
      }
    } catch (e) {
      console.error("[member-import] row failed", rowNum, e);
      skipped.push({ row: rowNum, reason: t("skip.error") });
    }
  }

  // Provision queued serials at CitizenPay in one bulk call, then create the
  // local card, auto-number it, and link it as the member's primary (active).
  if (toProvision.length > 0) {
    if (!fund.citizenPayFundId) {
      serialsNotFound.push(...toProvision.map((p) => p.serial)); // not connected
    } else {
      try {
        const cp = getCitizenPayClient(fund);
        await cp.bulkCreateCards(toProvision.map((p) => p.serial));
        for (const p of toProvision) {
          try {
            const detail = await cp.getCitizenPayCard(p.serial).catch(() => null);
            const card = await prisma.card.create({
              data: {
                fundId: fund.id,
                memberId: null,
                serialNumber: p.serial,
                account: detail?.account ?? null,
                status: detail?.status ?? "INACTIVE",
                number: await nextCardNumber(fund.id),
                issuedAt: new Date(),
              },
              select: { id: true },
            });
            await linkCardToMember(card.id, p.memberId, p);
            cardsLinked++;
          } catch (e) {
            console.error("[member-import] provision failed", p.serial, e);
            serialsNotFound.push(p.serial);
          }
        }
      } catch (e) {
        console.error("[member-import] bulkCreate failed", e);
        serialsNotFound.push(...toProvision.map((p) => p.serial));
      }
    }
  }

  revalidatePath("/members");
  return { ok: true, created, updated, skipped, cardsLinked, serialsNotFound };
}

async function createMember(args: {
  fundId: string;
  email: string;
  firstName: string;
  lastName: string;
  optional: Record<string, string>;
  household: Record<string, number>;
  tierId: string | undefined;
}): Promise<string> {
  // Retry on the (fundId, paymentReference) unique collision — same pattern as
  // the single-member invite.
  for (let attempt = 0; attempt < REFERENCE_RETRIES; attempt++) {
    try {
      const m = await prisma.member.create({
        data: {
          fundId: args.fundId,
          email: args.email,
          firstName: args.firstName,
          lastName: args.lastName,
          status: "INVITED",
          paymentReference: generatePaymentReference(),
          emailVerifiedAt: new Date(), // admin vouches for identity
          ...args.optional,
          ...args.household,
          ...(args.tierId ? { tierId: args.tierId } : {}),
        },
        select: { id: true },
      });
      return m.id;
    } catch (e) {
      const code = (e as { code?: string }).code;
      const target = (e as { meta?: { target?: unknown } }).meta?.target;
      const targets = Array.isArray(target) ? target : [target];
      if (
        code === "P2002" &&
        targets.some((x) => typeof x === "string" && x.includes("paymentReference"))
      ) {
        continue; // reference clash — regenerate
      }
      throw e;
    }
  }
  throw new Error("could not allocate a unique payment reference");
}

// Attach a card to a member: set it as their primary card and mark them
// active. Used for both existing-card links and freshly-provisioned cards.
async function linkCardToMember(
  cardId: string,
  memberId: string,
  name: { firstName: string; lastName: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.card.update({
      where: { id: cardId },
      data: {
        memberId,
        holderName: `${name.firstName} ${name.lastName}`.trim(),
      },
    });
    await tx.member.update({
      where: { id: memberId },
      data: { primaryCardId: cardId, status: "ACTIVE" },
    });
  });
}
