// SPDX-License-Identifier: AGPL-3.0-or-later

// The allocations export (issue #320): what each member paid in and received
// per allocation period, as a spreadsheet-ready CSV. One row per member per
// period:
//
//   period · last name · first name · deposits · minted · tier · tier amount
//
//   • deposits   — the member's matched incoming deposits attached to the
//                  period (the period page's "Deposits" tab);
//   • minted     — the member's CONFIRMED mints batched into the period (the
//                  "Mints" tab; pending and failed mints moved no tokens);
//   • tier amount — the allocation amount of the tier that drove the mint,
//                  or of the member's current tier when nothing was minted.
//                  It should equal `minted`; a difference is what the export
//                  is there to show.
//
// Two shapes share the columns: one period (linked from the period page), or
// every period of the fund (linked from the schedule), where the per-period
// rows are followed by one "Total" row per member over all periods. The total
// rows repeat amounts already listed above them, so they carry the total
// label in the period column and are easy to filter out before summing.
//
// Pure module (no Prisma, no I/O) so the file shape is unit-testable;
// ./export-data.ts loads the rows and app/api/allocations/export/route.ts
// wraps the result in a Response.

import {
  CSV_DELIMITER,
  formatCsvDecimal,
  serializeCsv,
} from "@/services/csv/serialize";

export type ExportTranslate = (key: string) => string;

export const ALLOCATION_EXPORT_COLUMNS = [
  "period",
  "lastName",
  "firstName",
  "deposits",
  "minted",
  "tier",
  "tierAmount",
] as const;

type Amount = string | number;

export type AllocationExportTier = { name: string; allocationAmount: Amount };

export type AllocationExportPeriod = { id: string; label: string };

export type AllocationExportMember = {
  id: string;
  firstName: string;
  lastName: string;
  // The member's tier today — the fallback when no mint recorded one.
  tier: AllocationExportTier | null;
};

export type AllocationExportDeposit = {
  periodId: string;
  memberId: string;
  amount: Amount;
};

export type AllocationExportMint = {
  periodId: string;
  memberId: string;
  amount: Amount;
  // The tier that drove the mint (snapshot on the operation).
  tier: AllocationExportTier | null;
};

// Amounts are Decimal(…, 2) columns: summing in integer cents keeps the
// totals exact where floats would drift.
function toCents(amount: Amount): number {
  const n = typeof amount === "number" ? amount : Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

type Cell = {
  depositCents: number;
  mintedCents: number;
  mintTier: AllocationExportTier | null;
};

type ExportRow = {
  periodLabel: string;
  member: AllocationExportMember;
  depositCents: number;
  mintedCents: number;
  tierName: string;
  tierCents: number | null;
};

function compareMembers(
  a: AllocationExportMember,
  b: AllocationExportMember,
  locale: string,
): number {
  return (
    a.lastName.localeCompare(b.lastName, locale) ||
    a.firstName.localeCompare(b.firstName, locale) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The export's rows, before formatting: for each period in the order given,
 * one row per member with a deposit or a mint in it (members sorted by name).
 * A deposit or mint whose period or member isn't in the inputs is ignored.
 */
export function allocationExportRows(input: {
  periods: readonly AllocationExportPeriod[];
  members: readonly AllocationExportMember[];
  deposits: readonly AllocationExportDeposit[];
  mints: readonly AllocationExportMint[];
  locale: string;
}): ExportRow[] {
  const members = new Map(input.members.map((m) => [m.id, m]));
  const byPeriod = new Map<string, Map<string, Cell>>(
    input.periods.map((p) => [p.id, new Map()]),
  );
  const cellFor = (periodId: string, memberId: string): Cell | null => {
    const period = byPeriod.get(periodId);
    if (!period || !members.has(memberId)) return null;
    let cell = period.get(memberId);
    if (!cell) {
      cell = { depositCents: 0, mintedCents: 0, mintTier: null };
      period.set(memberId, cell);
    }
    return cell;
  };

  for (const d of input.deposits) {
    const cell = cellFor(d.periodId, d.memberId);
    if (cell) cell.depositCents += toCents(d.amount);
  }
  for (const m of input.mints) {
    const cell = cellFor(m.periodId, m.memberId);
    if (!cell) continue;
    cell.mintedCents += toCents(m.amount);
    cell.mintTier ??= m.tier;
  }

  const rows: ExportRow[] = [];
  for (const period of input.periods) {
    const cells = byPeriod.get(period.id);
    if (!cells) continue;
    const periodRows = [...cells].map(([memberId, cell]): ExportRow => {
      const member = members.get(memberId)!;
      const tier = cell.mintTier ?? member.tier;
      return {
        periodLabel: period.label,
        member,
        depositCents: cell.depositCents,
        mintedCents: cell.mintedCents,
        tierName: tier?.name ?? "",
        tierCents: tier ? toCents(tier.allocationAmount) : null,
      };
    });
    periodRows.sort((a, b) => compareMembers(a.member, b.member, input.locale));
    rows.push(...periodRows);
  }
  return rows;
}

// One row per member over every period row they have: the three amounts
// summed (the tier amount as the sum of each period's, so it stays comparable
// with the minted total), the tier name left blank since it may have changed.
function totalRows(
  rows: readonly ExportRow[],
  label: string,
  locale: string,
): ExportRow[] {
  const totals = new Map<string, ExportRow>();
  for (const row of rows) {
    const total = totals.get(row.member.id);
    if (!total) {
      totals.set(row.member.id, { ...row, periodLabel: label, tierName: "" });
      continue;
    }
    total.depositCents += row.depositCents;
    total.mintedCents += row.mintedCents;
    if (row.tierCents != null) {
      total.tierCents = (total.tierCents ?? 0) + row.tierCents;
    }
  }
  return [...totals.values()].sort((a, b) =>
    compareMembers(a.member, b.member, locale),
  );
}

// A filename-safe token: asciified, lowercased, anything else dashed, so no
// header-encoding surprises reach Content-Disposition.
function filenameToken(value: string, fallback: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

/** `allocations_<fund>_<period label | all>_<yyyy-mm-dd>.csv` */
export function allocationExportFilename(
  fundDomain: string,
  periodLabel: string | null,
  today: string,
): string {
  const fund = filenameToken(fundDomain.split(".")[0] ?? "", "fund");
  const scope =
    periodLabel === null ? "all" : filenameToken(periodLabel, "period");
  return `allocations_${fund}_${scope}_${today}.csv`;
}

export type AllocationExportFile = {
  filename: string;
  csv: string;
  count: number;
};

/**
 * Build the downloadable file from already-fetched rows. `scope` picks the
 * shape: `period` exports that one period (its rows only); `all` exports
 * every period given, oldest first as supplied, then the per-member totals.
 */
export function buildAllocationExportCsv(input: {
  scope: "period" | "all";
  periods: readonly AllocationExportPeriod[];
  members: readonly AllocationExportMember[];
  deposits: readonly AllocationExportDeposit[];
  mints: readonly AllocationExportMint[];
  fundDomain: string;
  today: string;
  locale: string;
  t: ExportTranslate;
}): AllocationExportFile {
  const { scope, periods, fundDomain, today, locale, t } = input;
  const rows = allocationExportRows(input);
  const all =
    scope === "all"
      ? [...rows, ...totalRows(rows, t("fund.allocations.export.total"), locale)]
      : rows;

  const header = ALLOCATION_EXPORT_COLUMNS.map((c) =>
    t(`fund.allocations.export.columns.${c}`),
  );
  const body = all.map((row) => [
    row.periodLabel,
    row.member.lastName,
    row.member.firstName,
    formatCsvDecimal(row.depositCents / 100, locale),
    formatCsvDecimal(row.mintedCents / 100, locale),
    row.tierName,
    row.tierCents != null ? formatCsvDecimal(row.tierCents / 100, locale) : "",
  ]);

  return {
    filename: allocationExportFilename(
      fundDomain,
      scope === "period" ? (periods[0]?.label ?? "") : null,
      today,
    ),
    csv: serializeCsv([header, ...body], { delimiter: CSV_DELIMITER }),
    count: rows.length,
  };
}
