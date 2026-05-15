// SPDX-License-Identifier: AGPL-3.0-or-later
// Adds `// SPDX-License-Identifier: AGPL-3.0-or-later` to the top of every
// tracked TypeScript / JavaScript source file that doesn't already have one.
//
// Idempotent — re-running won't double up. Operates on `git ls-files` so
// node_modules, .next, and other gitignored output are skipped automatically.
//
// Usage:
//   node scripts/add-spdx-headers.mjs           # dry run, prints what would change
//   node scripts/add-spdx-headers.mjs --write   # actually write the files
//
// Run this after adding new source files; not wired into postinstall to keep
// builds fast.

import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const SPDX_LINE = "// SPDX-License-Identifier: AGPL-3.0-or-later";
const SPDX_MARKER = "SPDX-License-Identifier";
const WRITE = process.argv.includes("--write");

const SOURCE_EXTENSIONS = /\.(?:tsx|ts|mjs|cjs|jsx|js)$/;
const SKIP_PATHS = [
  "next-env.d.ts",
  "services/db/generated/",
];

const tracked = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const targets = tracked.filter((f) => {
  if (!SOURCE_EXTENSIONS.test(f)) return false;
  if (f.endsWith(".d.ts")) return false;
  if (SKIP_PATHS.some((skip) => f === skip || f.startsWith(skip))) return false;
  return true;
});

let added = 0;
let alreadyPresent = 0;

for (const file of targets) {
  const content = await readFile(file, "utf8");
  if (content.includes(SPDX_MARKER)) {
    alreadyPresent++;
    continue;
  }

  let next;
  if (content.startsWith("#!")) {
    // Shebang must remain on line 1; SPDX goes on line 2.
    const nl = content.indexOf("\n");
    if (nl === -1) {
      next = `${content}\n${SPDX_LINE}\n`;
    } else {
      next = `${content.slice(0, nl + 1)}${SPDX_LINE}\n${content.slice(nl + 1)}`;
    }
  } else {
    next = `${SPDX_LINE}\n${content}`;
  }

  if (WRITE) {
    await writeFile(file, next);
  }
  added++;
  if (!WRITE) console.log(`would add: ${file}`);
}

const verb = WRITE ? "added to" : "would add to";
console.log(
  `\n[add-spdx-headers] ${verb} ${added} file(s); ${alreadyPresent} already present.`,
);
if (!WRITE && added > 0) {
  console.log("Re-run with --write to apply.");
}
