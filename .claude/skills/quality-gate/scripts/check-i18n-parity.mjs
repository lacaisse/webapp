// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Check that every locale file in messages/ has the same key set as the
// default locale (fr). Run from the repo root:
//   node .claude/skills/quality-gate/scripts/check-i18n-parity.mjs
// Exits 1 and lists missing/extra keys per locale if they diverge.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "messages");
const DEFAULT_LOCALE = "fr";

function flatten(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out.add(key);
  }
  return out;
}

const locales = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

if (!locales.includes(DEFAULT_LOCALE)) {
  console.error(`✗ messages/${DEFAULT_LOCALE}.json not found`);
  process.exit(1);
}

const keysFor = (locale) =>
  flatten(JSON.parse(readFileSync(join(DIR, `${locale}.json`), "utf8")));

const base = keysFor(DEFAULT_LOCALE);
let failed = false;

for (const locale of locales.filter((l) => l !== DEFAULT_LOCALE)) {
  const keys = keysFor(locale);
  const missing = [...base].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`\n✗ messages/${locale}.json out of sync with ${DEFAULT_LOCALE}:`);
    for (const k of missing) console.error(`    missing: ${k}`);
    for (const k of extra) console.error(`    extra:   ${k}`);
  }
}

if (failed) process.exit(1);
console.log(`✓ ${locales.length} locales in sync (${base.size} keys)`);
