// SPDX-License-Identifier: AGPL-3.0-or-later
// Release command of the container image (docs/container.md). The runner
// starts a one-off container from the NEW image with the deployment's
// environment and runs, before the new version takes traffic:
//
//   node release/release.mjs           prisma migrate deploy
//   node release/release.mjs --seed    the same, then the synthetic seed
//                                      (staging only; scripts/seed-staging.ts)
//
// Exit 0 = success. Anything else aborts the deploy.
//
// Database TLS: when DATABASE_CA_CERT holds a PEM, Prisma's migration engine
// must verify the server against exactly that CA. The engine takes a CA as a
// FILE (`sslcert=<path>` in the URL, with `sslaccept=strict`), so the PEM is
// written to a private temporary directory (0700, file 0600), used, and
// removed. Unset, the URL reaches the engine unchanged. The seed builds its
// own connection from the same variables (services/db/tls.ts).
//
// Plain JS on purpose: it runs from release/ in the runtime image, next to
// the Prisma CLI and nothing else.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRISMA_CLI = join(HERE, "node_modules", "prisma", "build", "index.js");
const PRISMA_CONFIG = join(HERE, "prisma.config.ts");
const SEED = join(HERE, "seed-staging.mjs");

// libpq / Prisma URL parameters that steer TLS; replaced when the CA is set.
const TLS_URL_PARAMS = [
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslidentity",
  "sslpassword",
  "sslaccept",
  "sslnegotiation",
  "uselibpqcompat",
];

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

export function normalizeCaPem(raw) {
  const pem = raw.includes("\n") ? raw : raw.replace(/\\n/g, "\n");
  if (!PEM_CERT.test(pem)) {
    throw new Error("DATABASE_CA_CERT is set but holds no PEM certificate");
  }
  return pem.trim() + "\n";
}

/** The engine's URL: TLS required, chain and host verified against `caPath`. */
export function migrationUrlWithCa(url, caPath) {
  const u = new URL(url);
  for (const name of TLS_URL_PARAMS) u.searchParams.delete(name);
  u.searchParams.set("sslmode", "require");
  u.searchParams.set("sslcert", caPath);
  u.searchParams.set("sslaccept", "strict");
  return u.toString();
}

function run(label, args, env) {
  console.log(`[release] ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (result.error) {
    console.error(`[release] ${label} could not start: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`[release] ${label} killed by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}

function migrate() {
  // prisma.config.ts reads DIRECT_URL, then DATABASE_URL.
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("[release] DATABASE_URL (or DIRECT_URL) is not set");
    return 1;
  }
  const caRaw = process.env.DATABASE_CA_CERT;
  if (!caRaw || !caRaw.trim()) {
    return run("prisma migrate deploy", [PRISMA_CLI, "migrate", "deploy", "--config", PRISMA_CONFIG], process.env);
  }

  let dir;
  try {
    const pem = normalizeCaPem(caRaw);
    dir = mkdtempSync(join(tmpdir(), "lacaisse-db-ca-"));
    chmodSync(dir, 0o700);
    const caPath = join(dir, "ca.pem");
    writeFileSync(caPath, pem, { mode: 0o600 });
    const env = { ...process.env, DIRECT_URL: migrationUrlWithCa(url, caPath) };
    return run(
      "prisma migrate deploy (TLS verified against DATABASE_CA_CERT)",
      [PRISMA_CLI, "migrate", "deploy", "--config", PRISMA_CONFIG],
      env,
    );
  } catch (e) {
    console.error(`[release] ${e instanceof Error ? e.message : e}`);
    return 1;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--seed");
  if (unknown.length > 0) {
    console.error(`[release] unknown argument(s): ${unknown.join(" ")}`);
    return 64;
  }
  const status = migrate();
  if (status !== 0) return status;
  if (args.includes("--seed")) {
    return run("synthetic seed", [SEED], process.env);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
