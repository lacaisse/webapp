// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "./prisma";

export const READY_TIMEOUT_MS = 2_000;

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
    const result = await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    if (result === "timeout") {
      console.error(`[health] database did not answer within ${timeoutMs} ms`);
      return false;
    }
    return true;
  } catch (e) {
    // Driver-adapter errors often carry an empty message and the reason
    // (refused, TLS verification, auth) in `cause`. Never the URL.
    const err = e as { message?: string; name?: string; cause?: { message?: string; code?: string } };
    console.error(
      "[health] database check failed:",
      err.message || err.name || "unknown error",
      err.cause?.message ?? err.cause?.code ?? "",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}
