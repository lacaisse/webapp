// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";
import { parseHexKey } from "@/scripts/lib/app-cred-rotation";
import {
  applyRotation,
  RotationConflictError,
  scanRotation,
} from "@/scripts/lib/app-cred-rotation-db";

// One step of the APP_CRED_KEY re-encryption, for the maintenance route the
// self-hosted platform's rotation recipe calls until `done`
// (app/api/maintenance/reencrypt-app-cred). Same logic as
// `scripts/rotate-app-cred-key.ts --apply` (scripts/lib/app-cred-rotation*),
// in bounded batches:
//
//   - every encrypted cell is read and tried with APP_CRED_KEY first (cheap,
//     tens of rows today); the ones that only open with
//     APP_CRED_KEY_PREVIOUS are re-encrypted with the current key (same
//     envelope version and binding) and read back;
//   - at most `batchSize` of them are written, in one transaction, each
//     update conditioned on the cell still holding what was read;
//   - `remaining` is what is left after this batch; `done` = nothing left.
//
// Idempotent: a call after `done` scans, finds every cell current and writes
// nothing. Without APP_CRED_KEY_PREVIOUS (or with the same key twice) a cell
// that APP_CRED_KEY does not open cannot be migrated: it counts as failed.

export const REENCRYPT_BATCH_SIZE = 50;

export type ReencryptStep =
  | { kind: "ok"; done: boolean; reencrypted: number; remaining: number }
  // Some cell opens with neither key: nothing is written until that is fixed.
  | { kind: "failed"; remaining: number; failed: number }
  // A cell changed between the read and the write: the batch rolled back.
  | { kind: "conflict"; remaining: number }
  // APP_CRED_KEY / APP_CRED_KEY_PREVIOUS is missing or malformed.
  | { kind: "misconfigured" };

export async function reencryptStep(
  batchSize = REENCRYPT_BATCH_SIZE,
): Promise<ReencryptStep> {
  let current: Buffer;
  let previous: Buffer;
  try {
    current = parseHexKey("APP_CRED_KEY", process.env.APP_CRED_KEY);
    previous = process.env.APP_CRED_KEY_PREVIOUS
      ? parseHexKey("APP_CRED_KEY_PREVIOUS", process.env.APP_CRED_KEY_PREVIOUS)
      : current;
  } catch (e) {
    console.error("[reencrypt]", (e as Error).message);
    return { kind: "misconfigured" };
  }

  const scan = await scanRotation(prisma, { current, previous });
  if (scan.failures.length > 0) {
    // Row ids only, never contents.
    for (const f of scan.failures) {
      console.error(`[reencrypt] ${f.table}.${f.column} id=${f.id}: ${f.reason}`);
    }
    return {
      kind: "failed",
      remaining: scan.planned.length,
      failed: scan.failures.length,
    };
  }

  const batch = scan.planned.slice(0, batchSize);
  try {
    await applyRotation(prisma, batch);
  } catch (e) {
    if (e instanceof RotationConflictError) {
      console.warn("[reencrypt]", e.message);
      return { kind: "conflict", remaining: scan.planned.length };
    }
    throw e;
  }
  const remaining = scan.planned.length - batch.length;
  if (batch.length > 0) {
    console.log(`[reencrypt] re-encrypted ${batch.length} cell(s), ${remaining} remaining`);
  }
  return { kind: "ok", done: remaining === 0, reencrypted: batch.length, remaining };
}
