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

  // --- 2026-07 batch: newly published advisories against pre-existing deps ---
  // None of these are introduced by app code; each is a transitive package
  // reached only through build/dev tooling or a framework-bundled path.
  "GHSA-23hp-3jrh-7fpw": {
    pkg: "tar (transitive via node-gyp / pacote)",
    reason: "node-tar is reached only through npm's own install/build tooling (node-gyp, pacote); it is never imported by app code and is not in the Next production bundle. The parse/decompression DoS needs a malicious tarball fed at install time, not a runtime request. Clears when the tooling bumps its bundled tar.",
    reviewBy: "2026-10-01",
  },
  "GHSA-8x88-c5mf-7j5w": {
    pkg: "tar (transitive via node-gyp / pacote)",
    reason: "Same node-tar path as GHSA-23hp-3jrh-7fpw — install/build tooling only, no runtime surface. The negative-entry-size infinite loop requires a crafted archive fed at install time.",
    reviewBy: "2026-10-01",
  },
  "GHSA-3jxr-9vmj-r5cp": {
    pkg: "brace-expansion (transitive via minimatch)",
    reason: "ReDoS via a crafted glob pattern; brace-expansion is reached only through minimatch in build/lint/glob tooling, and every pattern is repo-authored, not attacker-supplied. Not in the runtime bundle.",
    reviewBy: "2026-10-01",
  },
  "GHSA-4c8g-83qw-93j6": {
    pkg: "fast-uri (transitive via ajv)",
    reason: "URI host-confusion inside ajv's `format` validation; fast-uri is reached only when ajv checks schema formats (eslint config, prisma, JSON-schema tool inputs). We never use ajv's URI parsing to make a security decision about a host or URL. Clears when ajv bumps its fast-uri range.",
    reviewBy: "2026-10-01",
  },
  "GHSA-v2hh-gcrm-f6hx": {
    pkg: "fast-uri (transitive via ajv)",
    reason: "Same fast-uri-via-ajv path as GHSA-4c8g-83qw-93j6 — schema `format` validation only, with no host/URL security decision made downstream.",
    reviewBy: "2026-10-01",
  },
  "GHSA-52cp-r559-cp3m": {
    pkg: "js-yaml (transitive via eslint / cosmiconfig)",
    reason: "Quadratic CPU on crafted YAML merge keys; js-yaml is reached only via eslint/cosmiconfig loading our own repo config at build/dev time. No attacker-supplied YAML, and not in the runtime bundle.",
    reviewBy: "2026-10-01",
  },
  "GHSA-f88m-g3jw-g9cj": {
    pkg: "sharp (bundled by next, image optimization)",
    reason: "libvips image CVEs inherited by Next's bundled sharp. sharp runs only for next/image, which this app uses solely for the static local logo (/logo.png); no images.remotePatterns is configured (so Next refuses to optimise remote URLs), and all user/CitizenPay-supplied images render via raw <img>, bypassing sharp. No untrusted image bytes reach libvips at runtime. Same deferred-fix class as the postcss-via-next entry; clears when Next bumps bundled sharp.",
    reviewBy: "2026-10-01",
  },

  // --- 2026-07-27 batch ---
  // Published after the 2026-07 triage above. The directly fixable ones were
  // fixed rather than triaged: next 16.2.9 -> 16.2.12 cleared four Next
  // advisories (2x SSRF, DoS, proxy bypass) and better-auth was patched via
  // `npm audit fix`. What remains is bundled or dev-only with no non-breaking
  // fix available.
  "GHSA-6g55-p6wh-862q": {
    pkg: "postcss (build, via next)",
    reason: "Arbitrary .map file read via an attacker-controlled sourceMappingURL comment. postcss here is the copy bundled inside next (node_modules/next/node_modules/postcss), run at build time over our own repo-authored CSS (Tailwind + globals.css) — no user- or tenant-supplied CSS is ever processed, so no attacker controls a sourceMappingURL. Not in the runtime bundle. Same deferred-fix class as GHSA-qx2v-qp2m-jg93; clears when Next bumps its bundled postcss.",
    reviewBy: "2026-10-01",
  },
  "GHSA-r28c-9q8g-f849": {
    pkg: "postcss (build, via next)",
    reason: "Same bundled-postcss-via-next path as GHSA-6g55-p6wh-862q — path traversal in previous-source-map auto-loading, reachable only if an attacker controls the CSS being compiled. Build-time only, repo-authored stylesheets.",
    reviewBy: "2026-10-01",
  },
  "GHSA-mh99-v99m-4gvg": {
    pkg: "brace-expansion (transitive via minimatch)",
    reason: "OOM crash from unbounded brace expansion. Same minimatch-in-build/lint-tooling path as GHSA-3jxr-9vmj-r5cp: every glob pattern is repo-authored, never attacker-supplied, and brace-expansion is not in the runtime bundle. Fix requires a breaking eslint 10 major.",
    reviewBy: "2026-10-01",
  },
  "GHSA-c96f-x56v-gq3h": {
    pkg: "find-my-way (dev, via @prisma/dev)",
    reason: "HTTP/2 DDoS in the router used by @prisma/dev's local dev server. Dev-only Prisma tooling — that server is never run in CI or production and is not in the Next bundle. Same class as the @hono/node-server-via-@prisma/dev entry (GHSA-92pp-h63x-v22m).",
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
