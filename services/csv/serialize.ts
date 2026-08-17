// SPDX-License-Identifier: AGPL-3.0-or-later

// CSV writer — the mirror of ./parse.ts, for the files we hand to a fund's
// accountant. Pure (no I/O) so exports can be unit-tested end to end.
//
// Three deliberate choices, all about Excel rather than about RFC 4180:
//
//   • **Semicolon delimiter.** Excel takes its field separator from the OS
//     list separator, which is `;` on the French/Belgian systems our funds'
//     accountants work on. A comma-delimited file opens there as a single
//     column. `./parse.ts` auto-detects the delimiter, so what we write still
//     round-trips through our own import flows.
//   • **UTF-8 BOM.** Without it Excel decodes the bytes as the legacy ANSI
//     codepage and mangles every accent ("Café" → "CafÃ©"). The BOM is the
//     only in-band way to tell it otherwise.
//   • **Locale decimal separator, never a thousands separator.** A French
//     Excel reads "1234.56" as text rather than a number, so amounts are
//     written with the locale's separator; a grouping separator (narrow
//     no-break space in fr) would break the parse in the other direction.
//
// CRLF line endings for the same reason — the one thing every spreadsheet on
// every platform agrees on.

export const CSV_DELIMITER = ";";
const BOM = "﻿";
const NEWLINE = "\r\n";

// Locales whose spreadsheets expect a decimal comma. Everything else gets a
// decimal point. Matched on the language subtag so "fr-BE" behaves like "fr".
const DECIMAL_COMMA_LANGUAGES = new Set(["fr", "es", "nl", "de", "it", "pt"]);

/** `,` or `.`, whichever the locale's spreadsheet will parse as a number. */
export function csvDecimalSeparator(locale: string): "," | "." {
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return DECIMAL_COMMA_LANGUAGES.has(language) ? "," : ".";
}

/**
 * A money amount for a CSV cell: fixed 2 decimals, the locale's decimal
 * separator, no grouping. Input is an EUR decimal string (what the CitizenPay
 * client hands us after converting cents) or a number.
 */
export function formatCsvDecimal(
  value: string | number | null | undefined,
  locale: string,
): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  const fixed = (Number.isFinite(n) ? n : 0).toFixed(2);
  return csvDecimalSeparator(locale) === "," ? fixed.replace(".", ",") : fixed;
}

// A leading `=`, `+` or `@` (or a control character) makes Excel treat the cell
// as a formula — an injection vector when the value came from a third party
// (merchant names arrive from CitizenPay). Neutralise it with a leading
// apostrophe, which spreadsheets read as "this is text". `-` is deliberately
// left alone so negative amounts stay numeric.
function neutralizeFormula(field: string): string {
  return /^[=+@\t\r]/.test(field) ? `'${field}` : field;
}

function escapeField(field: string, delimiter: string): string {
  const value = neutralizeFormula(field);
  const mustQuote =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r") ||
    value !== value.trim();
  return mustQuote ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Render rows (first row = header) as CSV text. Defaults to the
 * spreadsheet-friendly settings documented above; pass `bom: false` when the
 * consumer is a parser rather than Excel.
 */
export function serializeCsv(
  rows: readonly (readonly string[])[],
  opts: { delimiter?: string; bom?: boolean } = {},
): string {
  const delimiter = opts.delimiter ?? CSV_DELIMITER;
  const body = rows
    .map((row) => row.map((field) => escapeField(field, delimiter)).join(delimiter))
    .join(NEWLINE);
  // Trailing newline so appending or concatenating never glues two records.
  const text = rows.length > 0 ? `${body}${NEWLINE}` : "";
  return opts.bom === false ? text : `${BOM}${text}`;
}
