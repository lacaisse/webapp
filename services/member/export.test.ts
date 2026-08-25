// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseCsv } from "@/services/csv/parse";

import {
  buildMemberExportCsv,
  MEMBER_EXPORT_COLUMNS,
  memberExportFilename,
  type MemberForExport,
} from "./export";

function member(over: Partial<MemberForExport> & { firstName: string }): MemberForExport {
  return {
    lastName: "Doe",
    email: "jane@example.com",
    status: "ACTIVE",
    tier: { name: "Tier 1" },
    contributionAmount: "42.5",
    address: "1 Rue de la Paix",
    postalCode: "75001",
    city: "Paris",
    paymentReference: "FUND-0001",
    cards: [{ serialNumber: "SN-1" }],
    joinedAt: new Date("2026-03-15T10:00:00Z"),
    notes: null,
    ...over,
  };
}

// Identity translator: keys come back as themselves, which keeps the
// assertions about structure rather than about copy.
const t = (key: string) => key;

describe("memberExportFilename", () => {
  it("uses the fund's first domain label and the given date", () => {
    expect(memberExportFilename("acme.lacaisse.eu", "2026-08-25")).toBe(
      "members_acme_2026-08-25.csv",
    );
  });
});

describe("buildMemberExportCsv", () => {
  it("emits the localized header plus one row per member", () => {
    const file = buildMemberExportCsv({
      members: [member({ firstName: "Jane" }), member({ firstName: "John" })],
      fundDomain: "acme.lacaisse.eu",
      today: "2026-08-25",
      locale: "fr",
      t,
    });

    expect(file.count).toBe(2);
    expect(file.filename).toBe("members_acme_2026-08-25.csv");

    const parsed = parseCsv(file.csv);
    expect(parsed.headers).toEqual(
      MEMBER_EXPORT_COLUMNS.map((c) => `fund.members.export.columns.${c}`),
    );
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual([
      "Jane",
      "Doe",
      "jane@example.com",
      "members.admin.status.values.ACTIVE",
      "Tier 1",
      "42,50",
      "1 Rue de la Paix",
      "75001",
      "Paris",
      "FUND-0001",
      "SN-1",
      "2026-03-15",
      "",
    ]);
  });

  it("blanks optional fields rather than writing null/undefined text", () => {
    const file = buildMemberExportCsv({
      members: [
        member({
          firstName: "Jane",
          tier: null,
          contributionAmount: null,
          address: null,
          postalCode: null,
          city: null,
          paymentReference: null,
          cards: [],
        }),
      ],
      fundDomain: "acme.lacaisse.eu",
      today: "2026-08-25",
      locale: "en",
      t,
    });
    const cells = parseCsv(file.csv).rows[0];
    const at = (column: (typeof MEMBER_EXPORT_COLUMNS)[number]) =>
      cells[MEMBER_EXPORT_COLUMNS.indexOf(column)];
    expect(at("tier")).toBe("");
    expect(at("contributionAmount")).toBe("");
    expect(at("address")).toBe("");
    expect(at("postalCode")).toBe("");
    expect(at("city")).toBe("");
    expect(at("paymentReference")).toBe("");
    expect(at("cards")).toBe("");
  });

  it("joins multiple cards with a comma", () => {
    const file = buildMemberExportCsv({
      members: [
        member({
          firstName: "Jane",
          cards: [{ serialNumber: "SN-1" }, { serialNumber: "SN-2" }],
        }),
      ],
      fundDomain: "acme.lacaisse.eu",
      today: "2026-08-25",
      locale: "en",
      t,
    });
    const cells = parseCsv(file.csv).rows[0];
    expect(cells[MEMBER_EXPORT_COLUMNS.indexOf("cards")]).toBe("SN-1, SN-2");
  });

  it("writes a header-only file (never an empty download) for no members", () => {
    const file = buildMemberExportCsv({
      members: [],
      fundDomain: "acme.lacaisse.eu",
      today: "2026-08-25",
      locale: "fr",
      t,
    });
    expect(file.count).toBe(0);
    expect(parseCsv(file.csv).rows).toEqual([]);
    expect(file.csv.startsWith("﻿")).toBe(true);
  });
});
