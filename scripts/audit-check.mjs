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
  "GHSA-ggr8-5vv4-36mx": {
    pkg: "deepmerge-ts (transitive via prisma → @prisma/config)",
    reason:
      "Stack exhaustion when merging recursive object graphs. deepmerge-ts is reached only by the Prisma CLI merging our own repo-authored prisma.config.ts — never attacker-supplied input — and @prisma/config is not in the runtime bundle (PrismaClient comes from the generated client, not the prisma package). The advisory's fix range (>=8.0.0) isn't shipped by any prisma release: latest 7.9.1 still pins 7.1.5, and npm's only 'fix' is a breaking downgrade to prisma 6. Clears when @prisma/config bumps its deepmerge-ts range.",
    reviewBy: "2026-10-01",
  },
  "GHSA-3f6p-5ww8-9rcr": {
    pkg: "mysql2 (transitive via better-auth and prisma)",
    reason:
      "Auth plugin downgrade leaking plaintext credentials against a MySQL server. mysql2 is pulled in as an optional DB dialect of better-auth (our instance uses only the Prisma adapter — see services/auth/better-auth.ts) and by the Prisma CLI; we run exclusively against Postgres (DATABASE_URL/DIRECT_URL) and never construct a mysql2 connection anywhere in the app. Same blocker as the deepmerge-ts entry above: the only 'fix' npm offers is a breaking downgrade to prisma 6.19.3. Clears when better-auth/prisma bump their mysql2 range past 3.22.0.",
    reviewBy: "2026-10-01",
  },
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
