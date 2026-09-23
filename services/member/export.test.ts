// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseCsv } from "@/services/csv/parse";

import {
  buildMemberExportCsv,
  MEMBER_EXPORT_COLUMNS,
  memberExportFilename,
  memberExportQuestions,
  type MemberExportQuestion,
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
    applicationData: null,
    ...over,
  };
}

// Identity translator: keys come back as themselves, which keeps the
// assertions about structure rather than about copy.
const t = (key: string) => key;

// What the route injects: yes/no through the same identity translator, and a
// DATE answer left in its stored ISO form for the spreadsheet.
const answerFormatters = {
  boolean: (v: boolean) => (v ? "common.yes" : "common.no"),
  date: (v: string) => v,
};

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
      questions: [],
      answerFormatters,
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
      questions: [],
      answerFormatters,
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
      questions: [],
      answerFormatters,
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
      questions: [],
      answerFormatters,
    });
    expect(file.count).toBe(0);
    expect(parseCsv(file.csv).rows).toEqual([]);
    expect(file.csv.startsWith("﻿")).toBe(true);
  });

  it("appends one column per custom question, rendering option labels", () => {
    const questions: MemberExportQuestion[] = [
      {
        key: "income",
        label: "Tranche de revenus",
        field: {
          type: "SELECT",
          options: [
            { value: "t1", label: "moins de 1 500 €" },
            { value: "t2", label: "1 500 - 2 500 €" },
          ],
        },
      },
      {
        key: "household",
        label: "Composition du foyer",
        field: {
          type: "MULTISELECT",
          options: [
            { value: "adults", label: "Adultes" },
            { value: "kids", label: "Enfants" },
          ],
        },
      },
      {
        key: "consent",
        label: "Consentement",
        field: { type: "CHECKBOX", options: [] },
      },
      {
        key: "since",
        label: "Membre depuis",
        field: { type: "DATE", options: [] },
      },
    ];

    const file = buildMemberExportCsv({
      members: [
        member({
          firstName: "Jane",
          applicationData: {
            income: "t2",
            household: ["adults", "kids"],
            consent: true,
            since: "2026-01-09",
          },
        }),
      ],
      fundDomain: "acme.lacaisse.eu",
      today: "2026-08-25",
      locale: "fr",
      t,
      questions,
      answerFormatters,
    });

    const parsed = parseCsv(file.csv);
    expect(parsed.headers.slice(MEMBER_EXPORT_COLUMNS.length)).toEqual([
      "Tranche de revenus",
      "Composition du foyer",
      "Consentement",
      "Membre depuis",
    ]);
    expect(parsed.rows[0].slice(MEMBER_EXPORT_COLUMNS.length)).toEqual([
      "1 500 - 2 500 €",
      "Adultes, Enfants",
      "common.yes",
      "2026-01-09",
    ]);
  });

  it("leaves an unanswered question blank rather than dashed", () => {
    const questions: MemberExportQuestion[] = [
      { key: "income", label: "Tranche de revenus", field: { type: "SELECT", options: [] } },
    ];
    const file = buildMemberExportCsv({
      members: [member({ firstName: "Jane", applicationData: {} })],
      fundDomain: "acme.lacaisse.eu",
      today: "2026-08-25",
      locale: "fr",
      t,
      questions,
      answerFormatters,
    });
    expect(parseCsv(file.csv).rows[0].at(-1)).toBe("");
  });

  it("writes a stored value as-is when the question definition is gone", () => {
    const file = buildMemberExportCsv({
      members: [
        member({ firstName: "Jane", applicationData: { legacy: "kept" } }),
      ],
      fundDomain: "acme.lacaisse.eu",
      today: "2026-08-25",
      locale: "fr",
      t,
      questions: [{ key: "legacy", label: "legacy" }],
      answerFormatters,
    });
    const parsed = parseCsv(file.csv);
    expect(parsed.headers.at(-1)).toBe("legacy");
    expect(parsed.rows[0].at(-1)).toBe("kept");
  });
});

describe("memberExportQuestions", () => {
  const field = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    label: key.toUpperCase(),
    type: "TEXT" as const,
    config: null,
    ...over,
  });

  it("keeps the caller's field order and carries SELECT options through", () => {
    const columns = memberExportQuestions({
      fields: [
        field("income", {
          type: "SELECT",
          config: { options: [{ value: "t1", label: "Tier one" }] },
        }),
        field("household"),
      ],
      members: [{ applicationData: { household: "2" } }],
    });

    expect(columns.map((c) => c.key)).toEqual(["income", "household"]);
    expect(columns[0].label).toBe("INCOME");
    expect(columns[0].field).toEqual({
      type: "SELECT",
      options: [{ value: "t1", label: "Tier one" }],
    });
    // A malformed/absent config must not become `options: undefined`, which
    // formatOnboardingAnswer would then index into.
    expect(columns[1].field).toEqual({ type: "TEXT", options: [] });
  });

  it("adds a column for an answered key whose definition no longer exists", () => {
    const columns = memberExportQuestions({
      fields: [field("income")],
      members: [
        { applicationData: { income: "t1", removedQuestion: "an answer" } },
        { applicationData: null },
      ],
    });

    expect(columns.map((c) => c.key)).toEqual(["income", "removedQuestion"]);
    expect(columns[1]).toEqual({
      key: "removedQuestion",
      label: "removedQuestion",
    });
  });

  it("ignores orphan keys that hold no answer", () => {
    const columns = memberExportQuestions({
      fields: [],
      members: [
        { applicationData: { blank: "", empty: [], missing: null } },
      ],
    });
    expect(columns).toEqual([]);
  });
});
