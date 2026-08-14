// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure string helpers for {token} email templates — no server-only/db
// imports, so this stays unit-testable (see vitest.config.ts). Re-exported
// from ./templates for callers that already import from there.

// Replace {token} with vars[token]. Unknown tokens are left literal (the save
// validation already rejects those, so this only guards against drift).
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? vars[name] : whole,
  );
}

// Drop whole lines that reference a token whose value is "" — otherwise a flat
// substitution leaves a dangling label (e.g. "IBAN : ") when an optional value
// like the fund's not-yet-connected bank IBAN is blank. Applied before
// interpolate() so it works for both the built-in HTML defaults (one token per
// line) and an admin's own template authored the same way.
export function dropBlankTokenLines(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [name, value] of Object.entries(vars)) {
    if (value !== "") continue;
    result = result.replace(new RegExp(`^.*\\{${name}\\}.*\\n?`, "gm"), "");
  }
  return result;
}
