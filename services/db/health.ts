// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "./prisma";

export const READY_TIMEOUT_MS = 2_000;

// At most one `SELECT 1` in flight per process: callers that arrive while it
// runs wait for the same query (each with its own deadline). A database that
// hangs therefore holds one pool connection, not one per health poll.
let pendingProbe: Promise<unknown> | null = null;

function probe(): Promise<unknown> {
  if (!pendingProbe) {
    // A plain promise around Prisma's lazy one: started once, shared.
    const query: Promise<unknown> = (async () => prisma.$queryRaw`SELECT 1`)();
    pendingProbe = query;
    // Cleared when it settles, whoever still waits. The no-op catch keeps a
    // failure nobody awaits any more (every caller timed out) from becoming
    // an unhandled rejection.
    query.then(
      () => {
        pendingProbe = null;
      },
      () => {
        pendingProbe = null;
      },
    );
  }
  return pendingProbe;
}

/**
 * `SELECT 1` against the app's own Prisma client (same pool, same TLS
 * settings as every query), bounded by `timeoutMs`. Never throws: a failure
 * or a timeout is `false`, with the reason logged.
 */
export async function databaseReady(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([probe(), timeout]);
    if (result === "timeout") {
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
