// SPDX-License-Identifier: AGPL-3.0-or-later

// In-memory stand-in for the slice of Prisma the Safe core uses
// (proposals.ts / sync.ts / migration.ts), for their unit tests only.
// Implements just the where-semantics those modules rely on: equality, null,
// { in }, { not }, { lt }, OR, the `safe: { fundId }` relation filter on
// transactions / owners, and `signer: { is }` / `passkey: { is }` on owners.
// Not a general Prisma emulator.

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

let seq = 0;
const newId = (p: string) => `${p}-${++seq}`;

function matchValue(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond === "object" && cond !== null) {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return (c.in as unknown[]).includes(v);
    if ("not" in c) return v !== c.not;
    if ("lt" in c) {
      if (v === null || v === undefined) return false;
      const a = v instanceof Date ? v.getTime() : (v as number);
      const b = c.lt instanceof Date ? c.lt.getTime() : (c.lt as number);
      return a < b;
    }
    if ("equals" in c) return v === c.equals;
    if ("startsWith" in c) return typeof v === "string" && v.startsWith(c.startsWith as string);
    if ("gt" in c) {
      if (v === null || v === undefined) return false;
      const a = v instanceof Date ? v.getTime() : (v as number);
      const b = c.gt instanceof Date ? c.gt.getTime() : (c.gt as number);
      return a > b;
    }
    return false;
  }
  return v === cond;
}

export function createFakePrisma() {
  const db = {
    fundSafe: [] as Row[],
    fundSafeOwner: [] as Row[],
    fundSigner: [] as Row[],
    fundPasskeySigner: [] as Row[],
    fundSafeTransaction: [] as Row[],
    fundSafeSignature: [] as Row[],
    fundConversion: [] as Row[],
    tokenOperation: [] as Row[],
    fundDisplayToken: [] as Row[],
    fundMember: [] as Row[],
    user: [] as Row[],
  };

  const safeOf = (row: Row) => db.fundSafe.find((s) => s.id === row.safeId);

  function matches(row: Row, where: Where | undefined): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (k === "OR") {
        if (!(cond as Where[]).some((w) => matches(row, w))) return false;
        continue;
      }
      if (k === "safe" && typeof cond === "object" && cond !== null) {
        const safe = safeOf(row);
        if (!safe || !matches(safe, cond as Where)) return false;
        continue;
      }
      if ((k === "signer" || k === "passkey") && typeof cond === "object" && cond !== null) {
        const table = k === "signer" ? db.fundSigner : db.fundPasskeySigner;
        const fk = k === "signer" ? row.signerId : row.passkeyId;
        const related = table.find((r) => r.id === fk) ?? null;
        const inner = (cond as { is?: Where }).is ?? (cond as Where);
        if (!related || !matches(related, inner)) return false;
        continue;
      }
      if (!matchValue(row[k], cond)) return false;
    }
    return true;
  }

  function ownersOf(safeId: unknown, include: { where?: Where; include?: unknown } | true) {
    const where = include === true ? undefined : include.where;
    return db.fundSafeOwner
      .filter((o) => o.safeId === safeId && matches(o, where))
      .map((o) => {
        const signer = db.fundSigner.find((s) => s.id === o.signerId) ?? null;
        const passkey = db.fundPasskeySigner.find((p) => p.id === o.passkeyId) ?? null;
        const userOf = (userId: unknown) => db.user.find((u) => u.id === userId) ?? null;
        return {
          ...o,
          signer: signer ? { ...signer, user: userOf(signer.userId) } : null,
          passkey: passkey ? { ...passkey, user: userOf(passkey.userId) } : null,
        };
      });
  }

  function withSafeInclude(safe: Row, include?: Row): Row {
    if (!include) return { ...safe };
    const out: Row = { ...safe };
    if (include.owners) out.owners = ownersOf(safe.id, include.owners as { where?: Where });
    return out;
  }

  function withTxInclude(tx: Row, include?: Row): Row {
    if (!include) return { ...tx };
    const out: Row = { ...tx };
    if (include.signatures) {
      out.signatures = db.fundSafeSignature.filter((s) => s.transactionId === tx.id).map((s) => ({ ...s }));
    }
    if (include.safe) {
      const inc = include.safe === true ? undefined : ((include.safe as Row).include as Row | undefined);
      out.safe = withSafeInclude(safeOf(tx)!, inc);
    }
    return out;
  }

  function uniqueViolation(): Error {
    return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  }

  const prisma = {
    fundSafe: {
      findFirst: async (a: { where: Where; include?: Row }) => {
        const r = db.fundSafe.find((s) => matches(s, a.where));
        return r ? withSafeInclude(r, a.include) : null;
      },
      findMany: async (a: { where?: Where }) => db.fundSafe.filter((s) => matches(s, a.where)),
      create: async (a: { data: Row }) => {
        const { owners, ...data } = a.data;
        const row: Row = {
          id: newId("safe"),
          archivedAt: null,
          lastSyncedAt: null,
          errorMessage: null,
          deployTxHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        db.fundSafe.push(row);
        for (const o of ((owners as { create?: Row[] } | undefined)?.create ?? [])) {
          db.fundSafeOwner.push({
            id: newId("owner"),
            safeId: row.id,
            removedAt: null,
            signerId: null,
            passkeyId: null,
            label: null,
            addedAt: new Date(),
            ...o,
          });
        }
        return row;
      },
      update: async (a: { where: { id: string }; data: Row }) => {
        const r = db.fundSafe.find((s) => s.id === a.where.id)!;
        Object.assign(r, a.data, { updatedAt: new Date() });
        return r;
      },
      updateMany: async (a: { where: Where; data: Row }) => {
        const rows = db.fundSafe.filter((s) => matches(s, a.where));
        rows.forEach((r) => Object.assign(r, a.data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
    },
    fundSafeOwner: {
      findMany: async (a: { where: Where }) =>
        db.fundSafeOwner.filter((o) => matches(o, a.where)).map((o) => ({ ...o })),
      findFirst: async (a: { where: Where }) => {
        const r = db.fundSafeOwner.find((o) => matches(o, a.where));
        return r ? { ...r } : null;
      },
      count: async (a: { where: Where }) => db.fundSafeOwner.filter((o) => matches(o, a.where)).length,
      update: async (a: { where: { id: string }; data: Row }) => {
        const r = db.fundSafeOwner.find((o) => o.id === a.where.id)!;
        Object.assign(r, a.data);
        return r;
      },
      upsert: async (a: {
        where: { safeId_address: { safeId: string; address: string } };
        create: Row;
        update: Row;
      }) => {
        const { safeId, address } = a.where.safeId_address;
        const r = db.fundSafeOwner.find((o) => o.safeId === safeId && o.address === address);
        if (r) return Object.assign(r, a.update);
        const row = {
          id: newId("owner"),
          removedAt: null,
          signerId: null,
          passkeyId: null,
          label: null,
          addedAt: new Date(),
          ...a.create,
        };
        db.fundSafeOwner.push(row);
        return row;
      },
      updateMany: async (a: { where: Where; data: Row }) => {
        const rows = db.fundSafeOwner.filter((o) => matches(o, a.where));
        rows.forEach((r) => Object.assign(r, a.data));
        return { count: rows.length };
      },
    },
    fundSigner: {
      findUnique: async (a: {
        where: { fundId_userId?: { fundId: string; userId: string }; fundId_address?: { fundId: string; address: string } };
      }) => {
        if (a.where.fundId_userId) {
          const { fundId, userId } = a.where.fundId_userId;
          return db.fundSigner.find((s) => s.fundId === fundId && s.userId === userId) ?? null;
        }
        const { fundId, address } = a.where.fundId_address!;
        return db.fundSigner.find((s) => s.fundId === fundId && s.address === address) ?? null;
      },
      findMany: async (a: { where?: Where }) =>
        db.fundSigner.filter((s) => matches(s, a.where)).map((s) => ({ ...s })),
      updateMany: async (a: { where: Where; data: Row }) => {
        const rows = db.fundSigner.filter((s) => matches(s, a.where));
        rows.forEach((r) => Object.assign(r, a.data));
        return { count: rows.length };
      },
    },
    fundPasskeySigner: {
      findFirst: async (a: { where: Where }) => {
        const r = db.fundPasskeySigner.find((p) => matches(p, a.where));
        return r ? { ...r } : null;
      },
      findMany: async (a: { where?: Where }) =>
        db.fundPasskeySigner.filter((p) => matches(p, a.where)).map((p) => ({ ...p })),
      findUnique: async (a: {
        where: { id?: string; fundId_address?: { fundId: string; address: string } };
      }) => {
        if (a.where.id) return db.fundPasskeySigner.find((p) => p.id === a.where.id) ?? null;
        const { fundId, address } = a.where.fundId_address!;
        return (
          db.fundPasskeySigner.find(
            (p) => p.fundId === fundId && String(p.address).toLowerCase() === address.toLowerCase(),
          ) ?? null
        );
      },
      update: async (a: { where: { id: string }; data: Row }) => {
        const r = db.fundPasskeySigner.find((p) => p.id === a.where.id)!;
        Object.assign(r, a.data);
        return { ...r };
      },
      updateMany: async (a: { where: Where; data: Row }) => {
        const rows = db.fundPasskeySigner.filter((p) => matches(p, a.where));
        rows.forEach((r) => Object.assign(r, a.data));
        return { count: rows.length };
      },
    },
    fundSafeTransaction: {
      findFirst: async (a: { where: Where; include?: Row }) => {
        const r = db.fundSafeTransaction.find((t) => matches(t, a.where));
        return r ? withTxInclude(r, a.include) : null;
      },
      findMany: async (a: { where: Where; include?: Row }) =>
        db.fundSafeTransaction
          .filter((t) => matches(t, a.where))
          .sort((x, y) => (x.nonce as number) - (y.nonce as number))
          .map((t) => withTxInclude(t, a.include)),
      create: async (a: { data: Row }) => {
        const { signatures, ...data } = a.data;
        if (db.fundSafeTransaction.some((t) => t.safeTxHash === data.safeTxHash)) throw uniqueViolation();
        const row: Row = {
          id: newId("tx"),
          status: "PENDING",
          txHash: null,
          executedAt: null,
          executedBy: null,
          errorMessage: null,
          tokenOperationId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        db.fundSafeTransaction.push(row);
        const sig = (signatures as { create?: Row } | undefined)?.create;
        if (sig) db.fundSafeSignature.push({ id: newId("sig"), transactionId: row.id, ...sig });
        return row;
      },
      update: async (a: { where: { id: string }; data: Row }) => {
        const r = db.fundSafeTransaction.find((t) => t.id === a.where.id)!;
        Object.assign(r, a.data, { updatedAt: new Date() });
        return r;
      },
      updateMany: async (a: { where: Where; data: Row }) => {
        const rows = db.fundSafeTransaction.filter((t) => matches(t, a.where));
        rows.forEach((r) => Object.assign(r, a.data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
      aggregate: async (a: { where: Where }) => {
        const nonces = db.fundSafeTransaction.filter((t) => matches(t, a.where)).map((t) => t.nonce as number);
        return { _max: { nonce: nonces.length ? Math.max(...nonces) : null } };
      },
      // Signatures cascade (schema: onDelete Cascade).
      deleteMany: async (a: { where: Where }) => {
        const gone = db.fundSafeTransaction.filter((t) => matches(t, a.where));
        const ids = new Set(gone.map((t) => t.id));
        db.fundSafeTransaction = db.fundSafeTransaction.filter((t) => !ids.has(t.id));
        db.fundSafeSignature = db.fundSafeSignature.filter((s) => !ids.has(s.transactionId));
        return { count: gone.length };
      },
      count: async (a: { where: Where }) => db.fundSafeTransaction.filter((t) => matches(t, a.where)).length,
    },
    fundSafeSignature: {
      create: async (a: { data: Row }) => {
        if (
          db.fundSafeSignature.some(
            (s) => s.transactionId === a.data.transactionId && s.ownerAddress === a.data.ownerAddress,
          )
        ) {
          throw uniqueViolation();
        }
        const row = { id: newId("sig"), signerId: null, passkeyId: null, userId: null, ...a.data };
        db.fundSafeSignature.push(row);
        return row;
      },
    },
    tokenOperation: {
      create: async (a: { data: Row }) => {
        const row = { id: newId("op"), ...a.data };
        db.tokenOperation.push(row);
        return row;
      },
    },
    // Token conversions (services/convert/engine.ts / progress.ts).
    fundConversion: {
      findFirst: async (a: { where: Where }) => {
        const r = db.fundConversion.find((c) => matches(c, a.where));
        return r ? { ...r } : null;
      },
      findMany: async (a: { where?: Where; take?: number }) => {
        const rows = db.fundConversion
          .filter((c) => matches(c, a.where))
          .sort((x, y) => (x.updatedAt as Date).getTime() - (y.updatedAt as Date).getTime())
          .map((c) => ({ ...c }));
        return a.take === undefined ? rows : rows.slice(0, a.take);
      },
      create: async (a: { data: Row }) => {
        const row: Row = {
          id: newId("conv"),
          holderKind: "SAFE",
          amountOut: null,
          round: 0,
          validUntil: null,
          errorMessage: null,
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...a.data,
        };
        db.fundConversion.push(row);
        return { ...row };
      },
      updateMany: async (a: { where: Where; data: Row }) => {
        const rows = db.fundConversion.filter((c) => matches(c, a.where));
        rows.forEach((r) => Object.assign(r, a.data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
      delete: async (a: { where: { id: string } }) => {
        const i = db.fundConversion.findIndex((c) => c.id === a.where.id);
        if (i === -1) throw Object.assign(new Error("Record not found"), { code: "P2025" });
        const [row] = db.fundConversion.splice(i, 1);
        // Steps keep their row but lose the link (schema: onDelete SetNull).
        db.fundSafeTransaction.forEach((t) => {
          if (t.conversionId === row.id) t.conversionId = null;
        });
        return row;
      },
    },
    fundDisplayToken: {
      findFirst: async (a: { where: Where }) => {
        const r = db.fundDisplayToken.find((t) => matches(t, a.where));
        return r ? { ...r } : null;
      },
    },
    fundMember: {
      findMany: async (a: { where: Where }) => db.fundMember.filter((m) => matches(m, a.where)),
    },
    user: {
      findUnique: async (a: { where: { id: string } }) => db.user.find((u) => u.id === a.where.id) ?? null,
    },
  };

  return { prisma, db };
}

// Module-level instance so a test's `vi.mock("@/services/db/prisma")`
// factory and the test body share one store.
export const fake = createFakePrisma();

export function resetFake(): void {
  for (const rows of Object.values(fake.db)) rows.length = 0;
}
