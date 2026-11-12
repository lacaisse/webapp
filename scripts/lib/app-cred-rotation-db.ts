// SPDX-License-Identifier: AGPL-3.0-or-later
// Database side of the APP_CRED_KEY rotation, shared by the CLI
// (scripts/rotate-app-cred-key.ts) and the maintenance route the self-hosted
// platform calls (app/api/maintenance/reencrypt-app-cred). The per-cell
// decision is ./app-cred-rotation.ts (`rotateEnvelope`); this module reads
// the four encrypted columns, plans the re-encryptions, and writes a plan in
// one transaction where every update is conditioned on the cell still holding
// the envelope that was read.
//
// The client is a parameter: the CLI builds its own (the app's
// services/db/prisma.ts is `server-only`), the route passes the app's.

import type { PrismaClient } from "../../services/db/generated/client";

import {
  countOutcome,
  emptyCounts,
  rotateEnvelope,
  signerBinding,
  type ColumnCounts,
  type RowOutcome,
} from "./app-cred-rotation";

export type RotationKeys = { current: Buffer; previous: Buffer };

export type FundColumn =
  | "tokenMinterPrivateKeyEnc"
  | "citizenPayApiKeyEnc"
  | "citizenPayEventsSecretEnc";

export const FUND_COLUMNS: FundColumn[] = [
  "tokenMinterPrivateKeyEnc",
  "citizenPayApiKeyEnc",
  "citizenPayEventsSecretEnc",
];

export type PlannedRotation =
  | { table: "Fund"; id: string; column: FundColumn; from: string; to: string }
  | {
      table: "FundSigner";
      id: string;
      fundId: string;
      userId: string;
      column: "privateKeyEnc";
      from: string;
      to: string;
    };

export type RotationFailure = { table: string; id: string; column: string; reason: string };

export type RotationScan = {
  /** Per `Table.column`, in a stable order (the CLI prints it). */
  counts: Map<string, ColumnCounts>;
  /** Cells sealed under the previous key, re-encrypted and read back. */
  planned: PlannedRotation[];
  /** Cells neither key opens. Never carries plaintext or key material. */
  failures: RotationFailure[];
};

/** Thrown by `applyRotation` when a cell changed between scan and write. */
export class RotationConflictError extends Error {}

type RotationDb = Pick<PrismaClient, "fund" | "fundSigner" | "$transaction">;

/** Read every encrypted cell and decide what to do with it. Writes nothing. */
export async function scanRotation(
  db: RotationDb,
  keys: RotationKeys,
): Promise<RotationScan> {
  const counts = new Map<string, ColumnCounts>();
  const planned: PlannedRotation[] = [];
  const failures: RotationFailure[] = [];

  const record = (
    table: "Fund" | "FundSigner",
    column: string,
    id: string,
    outcome: RowOutcome,
  ) => {
    const label = `${table}.${column}`;
    const c = counts.get(label) ?? emptyCounts();
    countOutcome(c, outcome);
    counts.set(label, c);
    if (outcome.status === "failed") {
      failures.push({ table, id, column, reason: outcome.reason });
    }
  };

  const funds = await db.fund.findMany({
    where: {
      OR: FUND_COLUMNS.map((column) => ({ [column]: { not: null } })),
    },
    select: {
      id: true,
      tokenMinterPrivateKeyEnc: true,
      citizenPayApiKeyEnc: true,
      citizenPayEventsSecretEnc: true,
    },
    orderBy: { id: "asc" },
  });
  for (const column of FUND_COLUMNS) counts.set(`Fund.${column}`, emptyCounts());
  for (const fund of funds) {
    for (const column of FUND_COLUMNS) {
      const from = fund[column];
      if (!from) continue;
      const outcome = rotateEnvelope(from, keys);
      record("Fund", column, fund.id, outcome);
      if (outcome.status === "migrate") {
        planned.push({ table: "Fund", id: fund.id, column, from, to: outcome.next });
      }
    }
  }

  const signers = await db.fundSigner.findMany({
    where: { privateKeyEnc: { not: null } },
    select: { id: true, fundId: true, userId: true, privateKeyEnc: true },
    orderBy: { id: "asc" },
  });
  counts.set("FundSigner.privateKeyEnc", emptyCounts());
  for (const signer of signers) {
    const from = signer.privateKeyEnc!;
    const outcome = rotateEnvelope(from, keys, signerBinding(signer.fundId, signer.userId));
    record("FundSigner", "privateKeyEnc", signer.id, outcome);
    if (outcome.status === "migrate") {
      planned.push({
        table: "FundSigner",
        id: signer.id,
        fundId: signer.fundId,
        userId: signer.userId,
        column: "privateKeyEnc",
        from,
        to: outcome.next,
      });
    }
  }

  return { counts, planned, failures };
}

/**
 * Write `planned` in ONE interactive transaction. Each update is conditioned
 * on the cell still holding the envelope that was read (the app may re-seal
 * a row concurrently, e.g. a CP key re-issue or the signer v1→v2 upgrade); a
 * count other than 1 rolls the whole batch back with a RotationConflictError,
 * and a re-run picks the new value up.
 */
export async function applyRotation(
  db: RotationDb,
  planned: PlannedRotation[],
): Promise<void> {
  if (planned.length === 0) return;
  await db.$transaction(
    async (tx) => {
      for (const row of planned) {
        const result =
          row.table === "Fund"
            ? await tx.fund.updateMany({
                where: { id: row.id, [row.column]: row.from },
                data: { [row.column]: row.to },
              })
            : await tx.fundSigner.updateMany({
                where: {
                  id: row.id,
                  fundId: row.fundId,
                  userId: row.userId,
                  privateKeyEnc: row.from,
                },
                data: { privateKeyEnc: row.to },
              });
        if (result.count !== 1) {
          throw new RotationConflictError(
            `${row.table}.${row.column} id=${row.id} changed while rotating (matched ${result.count}) — rolled back, re-run`,
          );
        }
      }
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}
