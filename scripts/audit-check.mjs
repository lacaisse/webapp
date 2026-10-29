// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dependency vulnerability gate for CI (see .github/workflows/ci.yml) and
// `npm run audit:ci`. Wraps `npm audit --json` and fails on any advisory at or
// above THRESHOLD that is NOT in the triaged ALLOWLIST below.
//
// Why an allowlist instead of bare `npm audit --audit-level=high`: several
// pre-existing advisories are transitive or dev-only and can only be "fixed"
// by a breaking downgrade of a direct dependency (viem, next, prisma). Gating
// on those bare would make every PR permanently red. The allowlist lets us
// keep the gate at `high` for NEW issues while explicitly accepting known,
// triaged ones — each with a reason and a review-by date.
//
// Adding an entry is a deliberate act: document why it's not exploitable here
// (or why the fix is deferred) and when to revisit.

import { execSync } from "node:child_process";

const THRESHOLD = "high"; // info | low | moderate | high | critical
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

// Keyed by GHSA id. Keep reasons specific and review-by dates honest.
//
// Emptied 2026-08-16: `npm audit` reports zero advisories at every severity
// after `npm audit fix` (in-range bumps of brace-expansion, fast-uri,
// ip-address, js-yaml, socket.io-parser, undici, hono) and the next
// 16.2.12 -> 16.3.1 bump (which replaced the bundled postcss 8.4.31 and
// sharp 0.34.5 with fixed versions). The remaining entries (tar, ws, esbuild,
// find-my-way, @hono/node-server) no longer matched any live advisory —
// stale before this cleanup. Keeping dead entries would suggest we still
// accept risks we no longer carry. See git history for the old entries and
// their triage rationale — they're the template for writing the next one.
const ALLOWLIST = {
  // 2026-10-20: `npm audit fix` moved next (16.4.2), prisma (7.10.1), sharp,
  // undici, proxy-addr, http-cache-semantics, source-map-js, engine.io and
  // @modelcontextprotocol/sdk past their advisories, and the 2026-08 entries
  // (deepmerge-ts, mysql2) cleared with prisma/better-auth and were removed.
  "GHSA-vfj7-8cjw-p6xm": {
    pkg: "braces (transitive via eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch, and via the shadcn CLI)",
    reason:
      "Stack exhaustion on deeply nested brace patterns. NOT fixable today: the advisory lists no patched version (GitHub: patched_versions null) and 3.0.3 is the newest braces on npm, so every consumer of micromatch carries it; npm's only 'fix' is a breaking downgrade to eslint-config-next 14 / shadcn 1. Both reach braces only from dev tooling run by hand on repo-authored globs (the Next lint plugin, the shadcn CLI) — never the app at runtime, never attacker-supplied patterns. Re-check for a braces release past 3.0.3 and drop this entry the day one ships.",
    reviewBy: "2026-12-01",
  },

  // 2026-10-29: the three better-auth 1.6 advisories (GHSA-965c-763c-88jm,
  // GHSA-r4xp-prcw-77qf, GHSA-q84f-53jg-9ppm) were allowlisted here for a
  // day, pending the move to better-auth 1.7 (first patched 1.7.0-rc.3 /
  // 1.7.7). That move — core `mcp` plugin → @better-auth/mcp + jwt(), with
  // the OAuth table migration — landed the same day; see the MCP section in
  // AGENTS.md. Nothing better-auth-related is accepted here anymore.
};

function runAudit() {
  try {
    return execSync("npm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // npm audit exits non-zero when advisories exist — the JSON is on stdout.
    if (e.stdout) return e.stdout.toString();
    throw e;
  }
}

const report = JSON.parse(runAudit());

// Collect distinct advisories (objects in each vuln's `via`) keyed by GHSA id.
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object" || !via.url) continue;
    const ghsa = via.url.split("/").pop();
    if (!advisories.has(ghsa)) {
      advisories.set(ghsa, { ghsa, title: via.title, severity: via.severity, name: via.name });
    }
  }
}

const min = RANK[THRESHOLD];
const blocking = [];
const accepted = [];
const staleAllowlist = [];
const now = new Date();

for (const adv of advisories.values()) {
  if ((RANK[adv.severity] ?? 0) < min) continue;
  const entry = ALLOWLIST[adv.ghsa];
  if (entry) {
    accepted.push({ adv, entry });
    if (entry.reviewBy && new Date(entry.reviewBy) < now) staleAllowlist.push({ adv, entry });
  } else {
    blocking.push(adv);
  }
}

if (accepted.length) {
  console.log(`Accepted ${accepted.length} triaged advisory/advisories (>= ${THRESHOLD}):`);
  for (const { adv, entry } of accepted) {
    console.log(`  - ${adv.ghsa} [${adv.severity}] ${entry.pkg} — review by ${entry.reviewBy}`);
  }
}

if (staleAllowlist.length) {
  console.warn(`\n⚠ ${staleAllowlist.length} allowlist entry/entries are past their review-by date — re-triage:`);
  for (const { adv } of staleAllowlist) console.warn(`  - ${adv.ghsa}`);
}

if (blocking.length) {
  console.error(`\n✗ ${blocking.length} un-triaged advisory/advisories at or above ${THRESHOLD}:\n`);
  for (const adv of blocking) {
    console.error(`  ${adv.ghsa} [${adv.severity}]  ${adv.name}\n    ${adv.title}\n    https://github.com/advisories/${adv.ghsa}`);
  }
  console.error("\nFix the dependency, or (if transitive/not-exploitable) add a documented entry to ALLOWLIST in scripts/audit-check.mjs.\n");
  process.exit(1);
}

console.log("\n✓ no un-triaged vulnerabilities at or above the threshold");
