// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Static guard for the architectural / permission conventions in AGENTS.md.
// Runs in CI on every PR (see .github/workflows/ci.yml) and is runnable
// locally via `npm run guard`. Pure Node, no dependencies — walks the source
// tree and applies a handful of HIGH-CONFIDENCE, low-false-positive rules.
//
// These are deliberately narrow: each rule encodes a documented footgun where
// a violation is almost certainly a real trust/permission bug, not a style
// nit. ESLint/Semgrep can layer on broader rules later; this keeps the
// security-relevant invariants enforced with zero extra tooling.
//
// Rules:
//   1. Client components must not import the server-only DB layer at runtime
//      (Prisma client/instance) — that would ship secrets/queries to the
//      browser. Type-only imports are fine (erased at build).
//   2. Client components must not read server-side env vars. Only
//      NEXT_PUBLIC_* (and NODE_ENV) are exposed to the browser; anything else
//      is a secret-leak risk.
//   3. "use server" files may only export async functions. Exporting consts,
//      classes, or sync functions silently becomes a broken server-reference
//      proxy at runtime (AGENTS.md). Types/interfaces are fine.
//   4. No NEXT_PUBLIC_ env var whose name looks like a secret
//      (SECRET/PRIVATE/PASSWORD/SERVICE_ROLE/CRED) — those must never be
//      public-bundled.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components", "services", "lib"];
const SKIP_DIRS = new Set(["node_modules", ".next", "generated", ".git"]);
const EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

// DB modules that must never reach the client at runtime.
const SERVER_ONLY_DB =
  /from\s+["'](?:@\/)?services\/db\/(?:prisma|generated\/client)["']/;

// Env vars that are legitimately readable in client code.
const CLIENT_SAFE_ENV = /^(?:NEXT_PUBLIC_|NODE_ENV$)/;

// NEXT_PUBLIC_ names that must never be public.
const SECRETISH = /(SECRET|PRIVATE|PASSWORD|SERVICE_ROLE|CRED)/;

/** @type {{file: string, line: number, rule: string, msg: string}[]} */
const violations = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (EXTS.has(name.slice(name.lastIndexOf(".")))) {
      checkFile(full);
    }
  }
}

// Detect a leading "use client" / "use server" directive, tolerating an
// SPDX comment / blank lines before it.
function leadingDirective(lines) {
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*"))
      continue;
    if (line === '"use client";' || line === "'use client';") return "client";
    if (line === '"use server";' || line === "'use server';") return "server";
    return null; // first real statement isn't a directive
  }
  return null;
}

function add(file, idx, rule, msg) {
  violations.push({ file: relative(ROOT, file), line: idx + 1, rule, msg });
}

function checkFile(file) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const directive = leadingDirective(lines);

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    // Rule 4 applies everywhere.
    const pub = trimmed.match(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/);
    if (pub && SECRETISH.test(pub[1])) {
      add(file, idx, "no-public-secret", `${pub[1]} is bundled to the client but its name reads as a secret`);
    }

    if (directive === "client") {
      // Rule 1: runtime DB import in a client component.
      if (SERVER_ONLY_DB.test(line) && !/^\s*import\s+type\b/.test(line)) {
        add(file, idx, "no-db-in-client", "client component imports the server-only DB layer at runtime (use `import type`, or move to a server action)");
      }
      // Rule 2: server env read in a client component.
      const env = trimmed.match(/process\.env\.([A-Z0-9_]+)/);
      if (env && !CLIENT_SAFE_ENV.test(env[1])) {
        add(file, idx, "no-server-env-in-client", `client component reads server env ${env[1]} (only NEXT_PUBLIC_* is exposed to the browser)`);
      }
    }

    if (directive === "server") {
      // Rule 3: only async function exports allowed in "use server" files.
      // Allow: export async function, export default async, export type/interface,
      // and bare re-exports (export { ... } / export * — those carry no value
      // unless they re-export a const, which is rare; keep the rule tight).
      if (/^export\s+(const|let|var|class)\b/.test(trimmed)) {
        add(file, idx, "use-server-async-only", '"use server" file exports a non-function value (becomes a broken server-reference proxy at runtime)');
      } else if (/^export\s+function\b/.test(trimmed)) {
        add(file, idx, "use-server-async-only", '"use server" file exports a non-async function (server actions must be async)');
      } else if (/^export\s+default\s+function\b/.test(trimmed) && !/^export\s+default\s+async\b/.test(trimmed)) {
        add(file, idx, "use-server-async-only", '"use server" file default-exports a non-async function');
      }
    }
  });
}

for (const d of SCAN_DIRS) walk(join(ROOT, d));

if (violations.length === 0) {
  console.log("✓ convention guards passed");
  process.exit(0);
}

console.error(`\n✗ ${violations.length} convention/permission violation(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.rule}]\n    ${v.msg}`);
}
console.error("\nSee AGENTS.md for the rationale behind each rule.\n");
process.exit(1);
