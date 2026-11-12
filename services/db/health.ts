// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { selectOne } from "./health-probe";

export const READY_TIMEOUT_MS = 2_000;

// At most one `SELECT 1` in flight per process: callers that arrive while it
// runs wait for the same query (each with its own deadline). The query runs
// on its own short-lived connection, bounded on the client side
// (./health-probe.ts), so it always settles; and a caller whose deadline
// passes drops the shared probe, so the next check starts a fresh one even
// if the old one somehow never settles.
let pendingProbe: Promise<unknown> | null = null;

function probe(timeoutMs: number): Promise<unknown> {
  if (!pendingProbe) {
    const query: Promise<unknown> = selectOne(timeoutMs);
    pendingProbe = query;
    // Cleared when it settles, whoever still waits. The no-op catch keeps a
    // failure nobody awaits any more (every caller timed out) from becoming
    // an unhandled rejection.
    const clear = () => {
      if (pendingProbe === query) pendingProbe = null;
    };
    query.then(clear, clear);
  }
  return pendingProbe;
}

/**
 * `SELECT 1` against the app's database (same URL and TLS settings as the
 * Prisma client, its own bounded connection), within `timeoutMs`. Never throws: a failure
 * or a timeout is `false`, with the reason logged.
 */
export async function databaseReady(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const p = probe(timeoutMs);
    const result = await Promise.race([p, timeout]);
    if (result === "timeout") {
      if (pendingProbe === p) pendingProbe = null;
      console.error(`[health] database did not answer within ${timeoutMs} ms`);
      return false;
    }
    return true;
  } catch (e) {
    // The whole error: driver-adapter errors often carry an empty message
    // and the reason (refused, TLS verification, auth) in nested fields.
    // Neither Prisma nor pg puts the connection string in them.
    console.error("[health] database check failed:", e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
