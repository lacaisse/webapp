// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseCsv } from "./parse";
import {
  csvDecimalSeparator,
  formatCsvDecimal,
  serializeCsv,
} from "./serialize";

const BOM = "﻿";

describe("serializeCsv", () => {
  it("writes semicolon-delimited CRLF records behind a UTF-8 BOM", () => {
    expect(serializeCsv([["a", "b"], ["1", "2"]])).toBe(
      `${BOM}a;b\r\n1;2\r\n`,
    );
  });

  it("omits the BOM on request", () => {
    expect(serializeCsv([["a"]], { bom: false })).toBe("a\r\n");
  });

  it("quotes fields containing the delimiter, quotes, newlines or edge spaces", () => {
    expect(serializeCsv([["a;b", 'say "hi"', "two\nlines", " padded "]], {
      bom: false,
    })).toBe(`"a;b";"say ""hi""";"two\nlines";" padded "\r\n`);
  });

  it("neutralises spreadsheet formulas without touching negative numbers", () => {
    expect(
      serializeCsv([["=1+1", "+34", "@name", "-12.50"]], { bom: false }),
    ).toBe(`'=1+1;'+34;'@name;-12.50\r\n`);
  });

  it("round-trips through our own parser, which auto-detects the delimiter", () => {
    const csv = serializeCsv([
      ["Commerçant", "Net"],
      ["Café; Chez Léa", "1234,56"],
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["Commerçant", "Net"]);
    expect(parsed.rows).toEqual([["Café; Chez Léa", "1234,56"]]);
  });

  it("renders an empty sheet as an empty string", () => {
    expect(serializeCsv([], { bom: false })).toBe("");
  });
});

describe("formatCsvDecimal", () => {
  it("uses a decimal comma for comma-decimal locales", () => {
    expect(csvDecimalSeparator("fr")).toBe(",");
    expect(csvDecimalSeparator("nl-BE")).toBe(",");
    expect(formatCsvDecimal("1234.5", "fr")).toBe("1234,50");
  });

  it("uses a decimal point elsewhere, and never groups thousands", () => {
    expect(csvDecimalSeparator("en-GB")).toBe(".");
    expect(formatCsvDecimal("1234567.891", "en")).toBe("1234567.89");
  });

  it("reads missing or unparseable money as zero", () => {
    expect(formatCsvDecimal(null, "fr")).toBe("0,00");
    expect(formatCsvDecimal("not-money", "en")).toBe("0.00");
  });
});
