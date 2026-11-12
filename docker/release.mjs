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
// removed. Unset, a URL that asks for TLS (`sslmode=require|verify-ca|
// verify-full`) gets `sslaccept=strict` (system roots): without it the engine
// would not verify at all. A URL without sslmode is left alone. The seed
// builds its own connection from the same variables (services/db/tls.ts).
//
// Migration URL: DIRECT_URL, else DATABASE_URL (an empty value counts as
// unset), resolved once and handed to the engine as DIRECT_URL.
// SIGTERM / SIGINT are passed on to the running child; the exit code is the
// child's.
//
// Plain JS on purpose: it runs from release/ in the runtime image, next to
// the Prisma CLI and nothing else.

import { spawn } from "node:child_process";
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

/** The URL the engine gets: DIRECT_URL, else DATABASE_URL; empty counts as unset. */
export function resolveMigrationUrl(env) {
  const direct = env.DIRECT_URL?.trim();
  if (direct) return direct;
  const url = env.DATABASE_URL?.trim();
  return url || null;
}

const VERIFYING_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Without a CA: the engine skips certificate verification unless
 * `sslaccept=strict`, whatever `sslmode` says. A URL that asks for TLS gets
 * strict (verified against the system roots, fails closed). A URL without
 * `sslmode`, or with `sslmode=disable`, is left alone (local plain Postgres).
 */
export function migrationUrlWithoutCa(url) {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  if (!mode || !VERIFYING_SSLMODES.has(mode)) return url;
  u.searchParams.set("sslaccept", "strict");
  return u.toString();
}

// Signal forwarding: the runner stops a release that runs too long with
// SIGTERM. Node is PID 1 here (or under tini); pass the signal on to the
// running child so `migrate deploy` ends on its own terms, then exit with
// the child's status. A signal also stops anything that would come after.
let child = null;
let stopping = null;
function forwardSignals() {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      stopping = signal;
      console.error(`[release] ${signal} received${child ? ", passing it on" : ""}`);
      if (child) child.kill(signal);
      else process.exit(signal === "SIGTERM" ? 143 : 130);
    });
  }
}

function run(label, args, env) {
  console.log(`[release] ${label}`);
  return new Promise((resolve) => {
    child = spawn(process.execPath, args, { stdio: "inherit", env });
    child.on("error", (e) => {
      console.error(`[release] ${label} could not start: ${e.message}`);
      child = null;
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      child = null;
      if (signal) {
        console.error(`[release] ${label} ended by ${signal}`);
        resolve(signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const MIGRATE = [PRISMA_CLI, "migrate", "deploy", "--config", PRISMA_CONFIG];

async function migrate() {
  const url = resolveMigrationUrl(process.env);
  if (!url) {
    console.error("[release] DATABASE_URL (or DIRECT_URL) is not set");
    return 1;
  }
  // prisma.config.ts reads DIRECT_URL first: the child always gets exactly
  // the URL resolved here.
  const caRaw = process.env.DATABASE_CA_CERT;
  if (!caRaw || !caRaw.trim()) {
    let engineUrl;
    try {
      engineUrl = migrationUrlWithoutCa(url);
    } catch {
      console.error("[release] the database URL is not a valid URL");
      return 1;
    }
    const verified = engineUrl !== url;
    return run(
      verified ? "prisma migrate deploy (TLS verified against the system roots)" : "prisma migrate deploy",
      MIGRATE,
      { ...process.env, DIRECT_URL: engineUrl },
    );
  }

  let dir;
  try {
    const pem = normalizeCaPem(caRaw);
    dir = mkdtempSync(join(tmpdir(), "lacaisse-db-ca-"));
    chmodSync(dir, 0o700);
    const caPath = join(dir, "ca.pem");
    writeFileSync(caPath, pem, { mode: 0o600 });
    let engineUrl;
    try {
      engineUrl = migrationUrlWithCa(url, caPath);
    } catch {
      console.error("[release] the database URL is not a valid URL");
      return 1;
    }
    return await run(
      "prisma migrate deploy (TLS verified against DATABASE_CA_CERT)",
      MIGRATE,
      { ...process.env, DIRECT_URL: engineUrl },
    );
  } catch (e) {
    console.error(`[release] ${e instanceof Error ? e.message : e}`);
    return 1;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--seed");
  if (unknown.length > 0) {
    console.error(`[release] unknown argument(s): ${unknown.join(" ")}`);
    return 64;
  }
  const status = await migrate();
  if (status !== 0 || stopping) return status || 143;
  if (args.includes("--seed")) {
    return run("synthetic seed", [SEED], process.env);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  forwardSignals();
  main().then((code) => process.exit(code));
}
