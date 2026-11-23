// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseCsv } from "@/services/csv/parse";

import {
  ALLOCATION_EXPORT_COLUMNS,
  allocationExportFilename,
  allocationExportRows,
  buildAllocationExportCsv,
  type AllocationExportMember,
} from "./export";

// Identity translator: keys come back as themselves, which keeps the
// assertions about structure rather than about copy.
const t = (key: string) => key;

const standard = { name: "Standard", allocationAmount: "100.00" };
const solidaire = { name: "Solidaire", allocationAmount: "150.00" };

const periods = [
  { id: "p1", label: "2026-09" },
  { id: "p2", label: "2026-10" },
];
const members: AllocationExportMember[] = [
  { id: "m-zoe", firstName: "Zoé", lastName: "Martin", tier: standard },
  { id: "m-ali", firstName: "Ali", lastName: "Dupont", tier: solidaire },
];
const deposits = [
  { periodId: "p1", memberId: "m-zoe", amount: "20.10" },
  { periodId: "p1", memberId: "m-zoe", amount: "30.20" },
  { periodId: "p1", memberId: "m-ali", amount: "80.00" },
  { periodId: "p2", memberId: "m-zoe", amount: "50.00" },
  { periodId: "p2", memberId: "m-ali", amount: "10.00" },
];
const mints = [
  { periodId: "p1", memberId: "m-zoe", amount: "100.00", tier: standard },
  // Ali was on Standard when September was minted, Solidaire since.
  { periodId: "p1", memberId: "m-ali", amount: "100.00", tier: standard },
  { periodId: "p2", memberId: "m-zoe", amount: "100.00", tier: standard },
];

function build(scope: "period" | "all", only?: string) {
  const file = buildAllocationExportCsv({
    scope,
    periods: only ? periods.filter((p) => p.id === only) : periods,
    members,
    deposits,
    mints,
    fundDomain: "acme.lacaisse.eu",
    today: "2026-11-23",
    locale: "fr",
    t,
  });
  const parsed = parseCsv(file.csv);
  return { file, headers: parsed.headers, rows: parsed.rows };
}

describe("allocationExportFilename", () => {
  it("names the fund, the period and the date", () => {
    expect(
      allocationExportFilename("acme.lacaisse.eu", "2026-10", "2026-11-23"),
    ).toBe("allocations_acme_2026-10_2026-11-23.csv");
  });

  it("says 'all' for the every-period export and asciifies labels", () => {
    expect(allocationExportFilename("acme.lacaisse.eu", null, "2026-11-23")).toBe(
      "allocations_acme_all_2026-11-23.csv",
    );
    expect(
      allocationExportFilename("acme.lacaisse.eu", 'Été "2026"', "2026-11-23"),
    ).toBe("allocations_acme_ete-2026_2026-11-23.csv");
  });
});

describe("allocationExportRows", () => {
  it("sums deposits and mints per member per period, members by name", () => {
    const rows = allocationExportRows({
      periods,
      members,
      deposits,
      mints,
      locale: "fr",
    });
    expect(
      rows.map((r) => [
        r.periodLabel,
        r.member.lastName,
        r.depositCents,
        r.mintedCents,
        r.tierName,
        r.tierCents,
      ]),
    ).toEqual([
      ["2026-09", "Dupont", 8000, 10000, "Standard", 10000],
      ["2026-09", "Martin", 5030, 10000, "Standard", 10000],
      // No mint in October: Ali's current tier is what he was due.
      ["2026-10", "Dupont", 1000, 0, "Solidaire", 15000],
      ["2026-10", "Martin", 5000, 10000, "Standard", 10000],
    ]);
  });

  it("ignores rows for an unknown period or member", () => {
    const rows = allocationExportRows({
      periods: [periods[0]],
      members: [members[0]],
      deposits,
      mints,
      locale: "fr",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].member.id).toBe("m-zoe");
    expect(rows[0].depositCents).toBe(5030);
  });

  it("leaves the tier blank for a member without one", () => {
    const rows = allocationExportRows({
      periods: [periods[0]],
      members: [{ ...members[0], tier: null }],
      deposits: [{ periodId: "p1", memberId: "m-zoe", amount: 5 }],
      mints: [],
      locale: "fr",
    });
    expect(rows[0].tierName).toBe("");
    expect(rows[0].tierCents).toBeNull();
  });
});

describe("buildAllocationExportCsv", () => {
  it("exports one period without total rows", () => {
    const { file, headers, rows } = build("period", "p2");
    expect(file.filename).toBe("allocations_acme_2026-10_2026-11-23.csv");
    expect(file.count).toBe(2);
    expect(headers).toEqual(
      ALLOCATION_EXPORT_COLUMNS.map(
        (c) => `fund.allocations.export.columns.${c}`,
      ),
    );
    expect(rows).toEqual([
      ["2026-10", "Dupont", "Ali", "10,00", "0,00", "Solidaire", "150,00"],
      ["2026-10", "Martin", "Zoé", "50,00", "100,00", "Standard", "100,00"],
    ]);
  });

  it("exports every period, then one total row per member", () => {
    const { file, rows } = build("all");
    expect(file.filename).toBe("allocations_acme_all_2026-11-23.csv");
    expect(file.count).toBe(4);
    expect(rows).toHaveLength(4 + 2);
    expect(rows.slice(4)).toEqual([
      [
        "fund.allocations.export.total",
        "Dupont",
        "Ali",
        "90,00",
        "100,00",
        "",
        "250,00",
      ],
      [
        "fund.allocations.export.total",
        "Martin",
        "Zoé",
        "100,30",
        "200,00",
        "",
        "200,00",
      ],
    ]);
  });

  it("writes a decimal point for an English spreadsheet", () => {
    const file = buildAllocationExportCsv({
      scope: "period",
      periods: [periods[0]],
      members,
      deposits,
      mints,
      fundDomain: "acme.lacaisse.eu",
      today: "2026-11-23",
      locale: "en",
      t,
    });
    expect(parseCsv(file.csv).rows[1][3]).toBe("50.30");
  });

  it("is just the header when nothing was deposited or minted", () => {
    const file = buildAllocationExportCsv({
      scope: "all",
      periods,
      members: [],
      deposits: [],
      mints: [],
      fundDomain: "acme.lacaisse.eu",
      today: "2026-11-23",
      locale: "fr",
      t,
    });
    expect(parseCsv(file.csv).rows).toHaveLength(0);
    expect(file.count).toBe(0);
  });
});
