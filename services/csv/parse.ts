// SPDX-License-Identifier: AGPL-3.0-or-later

// Minimal RFC-4180-ish CSV parser: quoted fields with "" escaping, delimiter
// auto-detected from the header line (comma / semicolon / tab). Pure — shared
// by the client column-mapping UI (to populate header dropdowns) and the
// server import actions (which re-parse, never trusting the client).

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
  delimiter: string;
};

function detectDelimiter(line: string): string {
  const candidates: Array<readonly [string, number]> = [",", ";", "\t"].map(
    (d) => [d, line.split(d).length - 1] as const,
  );
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ",";
}

export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^﻿/, ""); // strip BOM
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    records.push(record);
    record = [];
  };

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === "\n") {
      pushField();
      pushRecord();
    } else if (c === "\r") {
      // ignore — \r\n handled by the \n branch; lone \r is rare
    } else {
      field += c;
    }
  }
  // Flush a trailing field/record (file without a final newline).
  if (field.length > 0 || record.length > 0) {
    pushField();
    pushRecord();
  }

  // Drop fully-empty records (blank lines, trailing newline).
  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [], delimiter };
  return {
    headers: nonEmpty[0].map((h) => h.trim()),
    rows: nonEmpty.slice(1),
    delimiter,
  };
}
