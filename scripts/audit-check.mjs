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
const ALLOWLIST = {
  "GHSA-96hv-2xvq-fx4p": {
    pkg: "ws (transitive via viem)",
    reason: "No ws server runs in this app; only viem's client paths. Fix requires a breaking viem downgrade — wait for viem to ship a patched ws range.",
    reviewBy: "2026-09-01",
  },
  "GHSA-g7r4-m6w7-qqqr": {
    pkg: "esbuild (dev, via vitest/vite)",
    reason: "Dev-only: arbitrary file read via esbuild's dev server on Windows. We never run that server; CI/prod don't ship esbuild.",
    reviewBy: "2026-09-01",
  },
  "GHSA-qx2v-qp2m-jg93": {
    pkg: "postcss (build, via next)",
    reason: "Build-time CSS stringify XSS; not reachable at runtime. Clears when Next bumps its bundled postcss.",
    reviewBy: "2026-09-01",
  },
  "GHSA-92pp-h63x-v22m": {
    pkg: "@hono/node-server (dev, via @prisma/dev)",
    reason: "Dev-only Prisma tooling (local dev server). Fix requires breaking prisma downgrade to 6.x.",
    reviewBy: "2026-09-01",
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
