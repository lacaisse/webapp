// SPDX-License-Identifier: AGPL-3.0-or-later

// The members data export: every member of the fund, one row per member, as a
// spreadsheet-ready CSV — for funds that need to hand member records to an
// accountant, a mail-merge tool, or a spreadsheet outside the dashboard
// (issue #206).
//
// Scoped to the fields that live as typed Member columns (what the /members
// table and detail page already show, plus address/payment-reference/notes).
// Per-fund custom onboarding answers (Member.applicationData) vary fund to
// fund and aren't included — a fund that needs those can still open the
// member detail page.
//
// Pure module (no Prisma, no I/O) so the CSV shape is unit-testable; the
// route handler in app/api/members/export/route.ts does the Prisma fetch and
// wraps this in a Response.

import {
  CSV_DELIMITER,
  formatCsvDecimal,
  serializeCsv,
} from "@/services/csv/serialize";

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
};

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

function row(
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

/**
 * Build the downloadable file from an already-fetched member list. The
 * status label and column headers are localized through `t`; the
 * contribution amount through the locale's decimal separator (see
 * services/csv/serialize.ts for the Excel reasoning).
 */
export function buildMemberExportCsv(input: {
  members: readonly MemberForExport[];
  fundDomain: string;
  today: string;
  locale: string;
  t: ExportTranslate;
}): MemberExportFile {
  const { members, fundDomain, today, locale, t } = input;
  const header = MEMBER_EXPORT_COLUMNS.map((c) =>
    t(`fund.members.export.columns.${c}`),
  );
  const rows = members.map((m) => {
    const cells = row(m, locale, t);
    return MEMBER_EXPORT_COLUMNS.map((c) => cells[c]);
  });

  return {
    filename: memberExportFilename(fundDomain, today),
    csv: serializeCsv([header, ...rows], { delimiter: CSV_DELIMITER }),
    count: members.length,
  };
}
