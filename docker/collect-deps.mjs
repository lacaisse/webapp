// SPDX-License-Identifier: AGPL-3.0-or-later
// Copy installed packages and everything they depend on, as installed by
// `npm ci` from the lockfile, into another node_modules. Used by the
// Dockerfile to give the release command (docker/release.mjs) the Prisma CLI
// without a second install (no network, same versions as the lockfile).
//
//   node docker/collect-deps.mjs <project root> <target node_modules> <pkg>...
//
// Follows `dependencies` and installed `optionalDependencies` (not peer
// dependencies: the CLI does not need them), resolving each name the way Node does:
// the nearest node_modules/<name> walking up from the requiring package.

import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const [rootArg, targetArg, ...roots] = process.argv.slice(2);
if (!rootArg || !targetArg || roots.length === 0) {
  console.error("usage: collect-deps.mjs <project root> <target node_modules> <pkg>...");
  process.exit(64);
}
const root = resolve(rootArg);
const rootModules = join(root, "node_modules");
const target = resolve(targetArg);

function findPackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const seen = new Set();
const queue = roots.map((name) => ({ name, from: root, required: true }));
while (queue.length > 0) {
  const { name, from, required } = queue.shift();
  const dir = findPackage(name, from);
  if (!dir) {
    if (required) {
      console.error(`collect-deps: ${name} is not installed (needed from ${relative(root, from) || "."})`);
      process.exit(1);
    }
    continue;
  }
  if (seen.has(dir)) continue;
  seen.add(dir);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    queue.push({ name: dep, from: dir, required: true });
  }
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    queue.push({ name: dep, from: dir, required: false });
  }
}

for (const dir of [...seen].sort()) {
  const rel = relative(rootModules, dir);
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    console.error(`collect-deps: ${dir} is outside ${rootModules}`);
    process.exit(1);
  }
  // Nested node_modules of a package are copied on their own if needed.
  cpSync(dir, join(target, rel), {
    recursive: true,
    filter: (src) => src === dir || !relative(dir, src).split(sep).includes("node_modules"),
  });
}
console.log(`collect-deps: ${seen.size} package(s) into ${target}`);
