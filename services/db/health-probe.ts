// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { Client } from "pg";

import { pgTlsConfig } from "./tls";

/**
 * One `SELECT 1` on a connection of its own, bounded on the client side:
 * connecting and the query each give up after `timeoutMs`, and the
 * connection is closed whatever happens. A database host that vanishes
 * without a reset therefore never holds a connection of the app's pool, and
 * the probe always settles. Same URL and TLS settings as the app's Prisma
 * client (services/db/tls.ts).
 */
export async function selectOne(timeoutMs: number): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new Client({
    ...pgTlsConfig(url, process.env.DATABASE_CA_CERT),
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    // Not awaited: on a vanished host the goodbye may never be answered.
    client.end().catch(() => {});
  }
}
