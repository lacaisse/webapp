// SPDX-License-Identifier: AGPL-3.0-or-later
// Postgres TLS for self-hosted deployments (docs/container.md).
//
// `DATABASE_CA_CERT` holds the PEM of the CA that signed the database
// server's certificate. When it is set, every connection the app opens is TLS
// with full verification against exactly that CA: the chain must lead to it
// and the server certificate must name the host of the URL (a DNS name or an
// IP address SAN). When it is unset, the connection string is handed to `pg`
// untouched, which is how the app has always connected (Vercel + Supabase).
//
// No `server-only`, no Prisma. services/db/prisma.ts (the app),
// scripts/seed-staging.ts (the synthetic seed) and the tests share it. The
// release command (docker/release.mjs) does the same for Prisma's migration
// engine, which takes a CA file instead of a PEM string.

import { checkServerIdentity, type PeerCertificate } from "node:tls";

/** Query parameters that steer TLS in a libpq-style URL; dropped when the CA is set. */
const TLS_URL_PARAMS = [
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslpassword",
  "sslaccept",
  "sslnegotiation",
  "uselibpqcompat",
];

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

export type PgTlsConfig = {
  connectionString: string;
  ssl?: {
    ca: string;
    rejectUnauthorized: true;
    checkServerIdentity: (servername: string, cert: PeerCertificate) => Error | undefined;
  };
};

/**
 * A PEM from the environment. Some secret stores flatten newlines to a
 * literal `\n`; accept that form too. Throws when the value holds no
 * certificate, so a broken bundle fails at start instead of silently falling
 * back to an unverified connection.
 */
export function normalizeCaPem(raw: string): string {
  const pem = raw.includes("\n") ? raw : raw.replace(/\\n/g, "\n");
  if (!PEM_CERT.test(pem)) {
    throw new Error("DATABASE_CA_CERT is set but holds no PEM certificate");
  }
  return pem.trim() + "\n";
}

/** The URL without the TLS query parameters (the PEM decides TLS instead). */
export function stripTlsParams(connectionString: string): string {
  const url = new URL(connectionString);
  for (const name of TLS_URL_PARAMS) url.searchParams.delete(name);
  return url.toString();
}

/** The host of a Postgres URL, IPv6 brackets removed. */
export function urlHost(connectionString: string): string {
  return new URL(connectionString).hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * `pg` pool settings for `connectionString` under `caPem`.
 *
 * `pg` lets the URL's own `sslmode` / `sslrootcert` override an `ssl` object
 * passed next to it, so with a CA the TLS parameters are removed from the URL
 * and the `ssl` object is the only source: `ca` replaces the system roots,
 * `rejectUnauthorized` refuses a chain that does not lead to it, and the
 * certificate must name the URL's host. That last check is explicit because
 * `pg` sets no TLS servername for an IP address (`10.0.0.6`), and Node then
 * checks the certificate against "localhost". A server without TLS is
 * refused.
 */
export function pgTlsConfig(
  connectionString: string,
  caPem: string | undefined,
): PgTlsConfig {
  if (!caPem || !caPem.trim()) return { connectionString };
  const host = urlHost(connectionString);
  return {
    connectionString: stripTlsParams(connectionString),
    ssl: {
      ca: normalizeCaPem(caPem),
      rejectUnauthorized: true,
      checkServerIdentity: (_servername, cert) => checkServerIdentity(host, cert),
    },
  };
}
