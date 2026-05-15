// SPDX-License-Identifier: AGPL-3.0-or-later
// Generates app/licenses/data.json from production dependencies for the
// public /licenses page. Runs on `postinstall` and `prebuild` (see
// package.json); the output is gitignored.
//
// Usage:
//   node scripts/generate-licenses.mjs
//
// AGPL §13 source availability is a separate concern (handled elsewhere).
// This file exists to satisfy the attribution clauses of bundled MIT /
// Apache-2.0 / ISC / BSD deps that ship in the browser bundle.

import * as checker from "license-checker-rseidelsohn";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outPath = resolve(root, "app/licenses/data.json");

const pkgJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const selfId = `${pkgJson.name}@${pkgJson.version}`;

function normaliseLicense(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(" / ");
  return "UNKNOWN";
}

function normaliseRepository(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return value.replace(/^git\+/, "").replace(/\.git$/, "");
  }
  if (typeof value === "object" && typeof value.url === "string") {
    return value.url.replace(/^git\+/, "").replace(/\.git$/, "");
  }
  return null;
}

checker.init(
  {
    start: root,
    production: true,
    excludePackages: selfId,
  },
  async (err, packages) => {
    if (err) {
      console.error("[generate-licenses]", err);
      process.exit(1);
    }
    const list = Object.entries(packages)
      .map(([id, info]) => {
        const at = id.lastIndexOf("@");
        return {
          name: id.slice(0, at),
          version: id.slice(at + 1),
          license: normaliseLicense(info.licenses),
          repository: normaliseRepository(info.repository),
          publisher: info.publisher ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(list, null, 2) + "\n");
    console.log(
      `[generate-licenses] wrote ${list.length} packages → app/licenses/data.json`,
    );
  },
);
