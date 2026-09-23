// SPDX-License-Identifier: AGPL-3.0-or-later

// The members data export: every member of the fund, one row per member, as a
// spreadsheet-ready CSV — for funds that need to hand member records to an
// accountant, a mail-merge tool, or a spreadsheet outside the dashboard
// (issue #206).
//
// Two blocks of columns, in this order:
//   1. the fields that live as typed Member columns (what the /members table
//      and detail page already show, plus address/payment-reference/notes);
//   2. one column per custom onboarding question the fund asks, read out of
//      Member.applicationData (issue #206 follow-up — "il manque toutes les
//      infos sur la tranche de revenus, composition du foyer").
//
// The second block is per-fund, so its columns are passed in rather than
// hardcoded: the caller resolves the fund's OnboardingField rows (and any
// answer key that outlived its definition) through `memberExportQuestions`.
//
// Pure module (no Prisma, no I/O) so the CSV shape is unit-testable; the
// route handler in app/api/members/export/route.ts does the Prisma fetch and
// wraps this in a Response.

import {
  CSV_DELIMITER,
  formatCsvDecimal,
  serializeCsv,
} from "@/services/csv/serialize";
import {
  formatOnboardingAnswer,
  isEmptyAnswer,
  type AnswerField,
  type AnswerFormatters,
} from "@/services/onboarding/format";

export type ExportTranslate = (key: string) => string;

export const MEMBER_EXPORT_COLUMNS = [
  "firstName",
  "lastName",
  "email",
  "status",
  "tier",
  "contributionAmount",
  "address",
  "postalCode",
  "city",
  "paymentReference",
  "cards",
  "joinedAt",
  "notes",
] as const;

type MemberExportColumn = (typeof MEMBER_EXPORT_COLUMNS)[number];

export type MemberForExport = {
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  tier: { name: string } | null;
  contributionAmount: string | number | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  paymentReference: string | null;
  cards: { serialNumber: string }[];
  joinedAt: Date;
  notes: string | null;
  // The fund's custom onboarding answers, keyed by OnboardingField.key.
  applicationData: Record<string, unknown> | null;
};

/** One custom-question column: which answer key it reads, and how to render it. */
export type MemberExportQuestion = {
  key: string;
  // Header text. The admin-authored question label, or the bare key when the
  // definition is gone (see memberExportQuestions).
  label: string;
  // Absent for an answer whose field definition no longer exists — the value
  // is then written as stored, exactly as the member detail page shows it.
  field?: AnswerField;
};

// The definition side of a custom question, as the caller reads it off
// OnboardingField. `builtinKey` rows must NOT be passed: those are answered
// into typed Member columns (address, city, tier, contribution) that the
// first block of columns already exports, and their `applicationData` is
// empty — a column per builtin would be a duplicate header full of blanks.
export type MemberExportFieldDef = {
  key: string;
  label: string;
  type: AnswerField["type"];
  config: unknown;
};

function optionsOf(config: unknown): AnswerField["options"] {
  const options = (config as { options?: AnswerField["options"] } | null)
    ?.options;
  return Array.isArray(options) ? options : [];
}

/**
 * The custom-question columns for an export: every question the fund has ever
 * asked (archived ones included — an archived question's historical answers
 * are exactly the kind of record an export exists to hand over), in the order
 * the caller supplies, followed by any answer key present in the data with no
 * surviving definition, so a renamed or hard-deleted question can never
 * silently drop a column of real answers.
 */
export function memberExportQuestions(input: {
  fields: readonly MemberExportFieldDef[];
  members: readonly Pick<MemberForExport, "applicationData">[];
}): MemberExportQuestion[] {
  const { fields, members } = input;
  const columns: MemberExportQuestion[] = fields.map((f) => ({
    key: f.key,
    label: f.label,
    field: { type: f.type, options: optionsOf(f.config) },
  }));

  const known = new Set(columns.map((c) => c.key));
  for (const m of members) {
    for (const [key, value] of Object.entries(m.applicationData ?? {})) {
      if (known.has(key) || isEmptyAnswer(value)) continue;
      known.add(key);
      columns.push({ key, label: key });
    }
  }

  return columns;
}

// The fund part of an export filename: the first label of its domain,
// asciified so no header-encoding surprises reach Content-Disposition.
// Mirrors services/payout/export.ts's fundFilenameLabel — small enough to not
// share, so each export stays free to evolve its own filename shape.
function fundFilenameLabel(fundDomain: string): string {
  return (
    fundDomain
      .split(".")[0]
      ?.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fund"
  );
}

/** `members_<fund>_<yyyy-mm-dd>.csv` */
export function memberExportFilename(
  fundDomain: string,
  today: string,
): string {
  return `members_${fundFilenameLabel(fundDomain)}_${today}.csv`;
}

export type MemberExportFile = {
  filename: string;
  csv: string;
  count: number;
};

function builtinCells(
  m: MemberForExport,
  locale: string,
  t: ExportTranslate,
): Record<MemberExportColumn, string> {
  return {
    firstName: m.firstName,
    lastName: m.lastName,
    email: m.email,
    status: t(`members.admin.status.values.${m.status}`),
    tier: m.tier?.name ?? "",
    contributionAmount:
      m.contributionAmount != null
        ? formatCsvDecimal(m.contributionAmount, locale)
        : "",
    address: m.address ?? "",
    postalCode: m.postalCode ?? "",
    city: m.city ?? "",
    paymentReference: m.paymentReference ?? "",
    cards: m.cards.map((c) => c.serialNumber).join(", "),
    joinedAt: m.joinedAt.toISOString().slice(0, 10),
    notes: m.notes ?? "",
  };
}

// An answered custom question, rendered the way the member detail page renders
// it (option LABELS rather than stored values, yes/no for checkboxes) — with
// an unanswered one left blank rather than dashed.
function answerCell(
  m: MemberForExport,
  question: MemberExportQuestion,
  formatters: AnswerFormatters,
): string {
  const value = m.applicationData?.[question.key];
  if (isEmptyAnswer(value)) return "";
  return formatOnboardingAnswer(value, question.field, formatters);
}

/**
 * Build the downloadable file from an already-fetched member list. The
 * status label and built-in column headers are localized through `t`; the
 * contribution amount through the locale's decimal separator (see
 * services/csv/serialize.ts for the Excel reasoning). Custom-question headers
 * are the fund's own admin-authored labels, already in its language, and
 * their answers are rendered through `answerFormatters` (see
 * services/onboarding/format.ts).
 */
export function buildMemberExportCsv(input: {
  members: readonly MemberForExport[];
  questions: readonly MemberExportQuestion[];
  fundDomain: string;
  today: string;
  locale: string;
  t: ExportTranslate;
  answerFormatters: AnswerFormatters;
}): MemberExportFile {
  const { members, questions, fundDomain, today, locale, t, answerFormatters } =
    input;
  const header = [
    ...MEMBER_EXPORT_COLUMNS.map((c) => t(`fund.members.export.columns.${c}`)),
    ...questions.map((q) => q.label),
  ];
  const rows = members.map((m) => {
    const cells = builtinCells(m, locale, t);
    return [
      ...MEMBER_EXPORT_COLUMNS.map((c) => cells[c]),
      ...questions.map((q) => answerCell(m, q, answerFormatters)),
    ];
  });

  return {
    filename: memberExportFilename(fundDomain, today),
    csv: serializeCsv([header, ...rows], { delimiter: CSV_DELIMITER }),
    count: members.length,
  };
}
