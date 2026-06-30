// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { normalizeSerial } from "@/services/card/serial";
import { parseCsv } from "@/services/csv/parse";
import { prisma } from "@/services/db/prisma";

import type { MemberStatus } from "@/services/db/generated/enums";

import {
  DEFAULT_IMPORT_STATUS,
  MEMBER_IMPORT_FIELDS,
  recognizeStatus,
  type MemberImportField,
  type MemberImportMapping,
  type MemberImportResult,
  type StatusValueMap,
} from "./import-config";
import { generatePaymentReference } from "./payment-reference";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const REFERENCE_RETRIES = 5;

// Bulk member import from a CSV with headers. The admin maps each built-in
// field to a column (firstName/lastName/email required). On a duplicate email
// the existing member is updated with the mapped values; otherwise a new member
// is created (status from the mapped status column, else NEW). A mapped IBAN is
// stored and learned for auto-matching; a mapped serial or card number links an
// EXISTING card (sets it primary; activates the member unless an explicit
// status was imported). Member import NEVER creates cards — cards are synced
// from CitizenPay or registered via the card flows; an unknown serial/number is
// reported, not provisioned (provisioning from here once minted junk CP cards).
export async function importMembersAction(input: {
  csv: string;
  mapping: MemberImportMapping;
  // Fixed values applied to every row for fields NOT mapped to a column
  // (e.g. assign one tier to the whole import). Ignored for a field that is
  // also column-mapped (the column wins).
  defaults?: MemberImportMapping;
  // Raw status value (lower-cased) → MemberStatus, from the dialog's
  // interactive mapping step. Re-validated here; values still unresolved fall
  // back to DEFAULT_IMPORT_STATUS and are reported in `statusesDefaulted`.
  statusValueMap?: StatusValueMap;
}): Promise<MemberImportResult> {
  const t = await getTranslations("members.admin.import");
  const { fund } = await requireFundRole("OPERATOR");
  const defaults = input.defaults ?? {};

  // Trust nothing from the client: rebuild the status map with lower-cased keys
  // and only enum-valid values.
  const VALID_STATUSES: ReadonlySet<string> = new Set([
    "NEW",
    "ACTIVE",
    "INACTIVE",
    "PAUSED",
    "STOPPED",
    "REJECTED",
  ]);
  const statusValueMap: StatusValueMap = {};
  for (const [raw, status] of Object.entries(input.statusValueMap ?? {})) {
    if (VALID_STATUSES.has(status)) statusValueMap[raw.trim().toLowerCase()] = status;
  }

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
  // Serials / card numbers that didn't link: no existing card, or the card
  // belongs to another member. Reported, never provisioned.
  const serialsNotFound: string[] = [];
  const cardNumbersNotFound: string[] = [];
  // Distinct raw status values we couldn't resolve and defaulted.
  const statusesDefaulted = new Set<string>();

  // Resolve a CSV status cell to a MemberStatus: explicit mapping first, then
  // auto-recognition, else the default (recorded for reporting). Returns
  // undefined when no status was supplied for the row (leave existing as-is).
  const resolveStatus = (raw: string): MemberStatus | undefined => {
    if (!raw) return undefined;
    const key = raw.toLowerCase();
    const mapped = statusValueMap[key] ?? recognizeStatus(raw);
    if (mapped) return mapped;
    statusesDefaulted.add(raw);
    return DEFAULT_IMPORT_STATUS;
  };

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

    const status = resolveStatus(valueFor("status"));

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
            ...(status ? { status } : {}),
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
          status,
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

      // Card linkage. Serial (free-form text) and/or per-fund card number,
      // both only from a mapped column — a fixed default would link the same
      // card to every row. Both paths only ever link an EXISTING card;
      // member import never creates cards. A serial that matches no card
      // falls back to a card-number lookup when it's digits-only (a number
      // column mapped as serial), and is reported otherwise.
      const rawSerial =
        colIndex.serial !== undefined ? valueFor("serial") : "";
      const rawCardNumber =
        colIndex.cardNumber !== undefined ? valueFor("cardNumber") : "";

      let cardNumber: number | null = null;
      if (rawCardNumber) {
        const n = Number(rawCardNumber);
        if (Number.isInteger(n) && n >= 1) cardNumber = n;
        else cardNumbersNotFound.push(rawCardNumber);
      }

      let rowCardHandled = false;
      const serial = normalizeSerial(rawSerial);
      if (serial) {
        const card = await prisma.card.findFirst({
          where: {
            fundId: fund.id,
            serialNumber: { equals: serial, mode: "insensitive" },
          },
          select: { id: true, memberId: true },
        });
        if (card && (card.memberId === null || card.memberId === memberId)) {
          await linkCardToMember(card.id, memberId, { firstName, lastName }, status);
          cardsLinked++;
          rowCardHandled = true;
        } else if (card) {
          serialsNotFound.push(serial); // attached to another member
        } else if (
          /^\d+$/.test(serial) &&
          Number(serial) >= 1 &&
          cardNumber === null
        ) {
          cardNumber = Number(serial); // a number column mapped as serial
        } else {
          serialsNotFound.push(serial); // no such card — not created
        }
      }
      if (!rowCardHandled && cardNumber !== null) {
        const card = await prisma.card.findFirst({
          where: { fundId: fund.id, number: cardNumber },
          select: { id: true, memberId: true },
        });
        if (card && (card.memberId === null || card.memberId === memberId)) {
          await linkCardToMember(card.id, memberId, { firstName, lastName }, status);
          cardsLinked++;
        } else {
          // No such card, or taken by another member — report, never create.
          cardNumbersNotFound.push(String(cardNumber));
        }
      }
    } catch (e) {
      console.error("[member-import] row failed", rowNum, e);
      skipped.push({ row: rowNum, reason: t("skip.error") });
    }
  }

  revalidatePath("/members");
  return {
    ok: true,
    created,
    updated,
    skipped,
    cardsLinked,
    serialsNotFound,
    cardNumbersNotFound,
    statusesDefaulted: [...statusesDefaulted],
  };
}

async function createMember(args: {
  fundId: string;
  email: string;
  firstName: string;
  lastName: string;
  optional: Record<string, string>;
  household: Record<string, number>;
  tierId: string | undefined;
  status: MemberStatus | undefined;
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
          status: args.status ?? DEFAULT_IMPORT_STATUS,
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

// Attach a card to a member: set it as their primary card. Linking a card
// activates the member by default, but an explicit imported status wins (so a
// member imported as e.g. PAUSED with a serial stays PAUSED).
async function linkCardToMember(
  cardId: string,
  memberId: string,
  name: { firstName: string; lastName: string },
  statusOverride: MemberStatus | undefined,
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
      data: { primaryCardId: cardId, status: statusOverride ?? "ACTIVE" },
    });
  });
}
