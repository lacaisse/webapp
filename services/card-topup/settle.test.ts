// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PaymentRequestState } from "@/services/citizenpay/types";

// The top-up state machine against an in-memory CardTopUp / TokenOperation
// store (updateMany honours its `where`, so the guarded transitions are
// exercised for real), a faked CitizenPay client and a faked mint.

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown> & { id: string };
const db = vi.hoisted(() => ({
  cardTopUp: [] as Row[],
  tokenOperation: [] as Row[],
  tokenOperationSource: [] as Row[],
  card: [] as Row[],
  seq: 0,
}));

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key.includes("_")) {
      // compound unique, e.g. fundId_citizenPayPaymentRequestId
      if (!matches(row, cond as Record<string, unknown>)) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
      if ("not" in c && c.not === null && value == null) return false;
      if ("equals" in c) {
        const eq = c.equals as string;
        if (c.mode === "insensitive") {
          if (String(value).toLowerCase() !== eq.toLowerCase()) return false;
        } else if (value !== eq) return false;
      }
      if ("lt" in c && !((value as Date) < (c.lt as Date))) return false;
      if ("gt" in c && !((value as Date) > (c.gt as Date))) return false;
      continue;
    }
    if (cond === null ? value != null : value !== cond) return false;
  }
  return true;
}

function pick(row: Row | undefined, select?: Record<string, boolean>) {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]));
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("unique", {
    code: "P2002",
    clientVersion: "test",
  });
}

function table(name: "cardTopUp" | "tokenOperation" | "tokenOperationSource" | "card") {
  return {
    findFirst: vi.fn(async ({ where, select, orderBy }: { where?: Record<string, unknown>; select?: Record<string, boolean>; orderBy?: unknown }) => {
      let rows = db[name].filter((r) => matches(r, where));
      if (orderBy) rows = [...rows].sort((a, b) => +(a.createdAt as Date) - +(b.createdAt as Date));
      return pick(rows[0], select);
    }),
    findUnique: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
      pick(db[name].find((r) => matches(r, where)), select),
    ),
    findUniqueOrThrow: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const row = db[name].find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      return pick(row, select);
    }),
    findMany: vi.fn(async ({ where, select }: { where?: Record<string, unknown>; select?: Record<string, boolean> }) =>
      db[name].filter((r) => matches(r, where)).map((r) => pick(r, select)),
    ),
    create: vi.fn(async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const row: Row = { id: `${name}-${++db.seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      if (name === "cardTopUp") {
        for (const key of ["citizenPayPaymentRequestId", "tokenOperationId", "bankTransactionId"]) {
          if (row[key] != null && db.cardTopUp.some((r) => r[key] === row[key] && r.fundId === row.fundId)) {
            throw uniqueViolation();
          }
        }
        row.status ??= "PENDING";
        row.tokenOperationId ??= null;
        row.bankTransactionId ??= null;
        row.citizenPayPaymentRequestId ??= null;
        row.memberId ??= null;
      }
      if (name === "tokenOperationSource" && db.tokenOperationSource.some((r) => r.bankTransactionId === row.bankTransactionId && r.tokenOperationId === row.tokenOperationId)) {
        throw uniqueViolation();
      }
      db[name].push(row);
      return pick(row, select);
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = db[name].find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = db[name].filter((r) => matches(r, where));
      for (const row of rows) {
        if (name === "cardTopUp" && data.citizenPayPaymentRequestId != null && db.cardTopUp.some((r) => r !== row && r.fundId === row.fundId && r.citizenPayPaymentRequestId === data.citizenPayPaymentRequestId)) {
          throw uniqueViolation();
        }
        Object.assign(row, data, { updatedAt: new Date() });
      }
      return { count: rows.length };
    }),
    upsert: vi.fn(async ({ where, create }: { where: Record<string, unknown>; create: Record<string, unknown> }) => {
      const row = db[name].find((r) => matches(r, where));
      if (row) return { ...row };
      const created: Row = { id: `${name}-${++db.seq}`, ...create };
      db[name].push(created);
      return created;
    }),
  };
}

const prisma = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/services/db/prisma", () => ({ prisma }));

const cp = vi.hoisted(() => ({ getPaymentRequest: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({
  getCitizenPayClient: () => cp,
}));

const userop = vi.hoisted(() => ({
  mintToken: vi.fn(),
  failedBeforeSubmit: vi.fn(),
}));
vi.mock("@/services/token/userop", () => ({
  ...userop,
  UserOpError: class UserOpError extends Error {
    code = "submit_failed";
  },
}));

const resolveOrEnqueueAnnotation = vi.hoisted(() => vi.fn());
vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation,
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({
  ANNOTATION_TRIGGERS: { cardTopUp: "CARD_TOPUP" },
}));

import { Prisma } from "@/services/db/generated/client";

import {
  attachPaymentRequest,
  claimTopUpDeposit,
  linkTopUpDeposit,
  settleCardTopUp,
  sweepCardTopUps,
  type TopUpFund,
} from "./settle";

const ACCOUNT = "0xAbCdEf0000000000000000000000000000000001";
const fund = {
  id: "fund-1",
  citizenPayFundId: "treasury-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
  tokenAddress: "0x3333333333333333333333333333333333333333",
  tokenDecimals: 6,
  tokenChainId: 100,
  tokenMinterPrivateKeyEnc: "v1:minter",
  tokenMinterEoaAddress: "0x1111111111111111111111111111111111111111",
  tokenMinterSmartAccountAddress: "0x2222222222222222222222222222222222222222",
  citizenPayEntrypointAddress: "0x4444444444444444444444444444444444444444",
  citizenPayAccountFactoryAddress: "0x5555555555555555555555555555555555555555",
  citizenPayPaymasterAddress: "0x6666666666666666666666666666666666666666",
  citizenPayPaymasterType: "cw-safe",
  allocationMode: "PAY_AND_GO",
} as unknown as TopUpFund;

function seedTopUp(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: `topup-${++db.seq}`,
    fundId: fund.id,
    cardId: "card-1",
    memberId: "member-1",
    account: ACCOUNT,
    citizenPayPaymentRequestId: 501,
    amountCents: 1250,
    status: "PENDING",
    tokenOperationId: null,
    bankTransactionId: null,
    createdAt: new Date(Date.now() - 5 * 60 * 1000),
    updatedAt: new Date(),
    ...over,
  };
  db.cardTopUp.push(row);
  return row;
}

function cpRequest(over: Partial<PaymentRequestState> = {}): PaymentRequestState {
  return {
    paymentRequestId: 501,
    status: "signed",
    amountCents: 1250,
    account: ACCOUNT.toLowerCase(),
    orderId: null,
    ...over,
  };
}

const TX = `0x${"ab".repeat(32)}`;

beforeEach(() => {
  vi.clearAllMocks();
  db.cardTopUp = [];
  db.tokenOperation = [];
  db.tokenOperationSource = [];
  db.card = [];
  Object.assign(prisma, {
    cardTopUp: table("cardTopUp"),
    tokenOperation: table("tokenOperation"),
    tokenOperationSource: table("tokenOperationSource"),
    card: table("card"),
    // Interactive transaction: on a throw, undo the ops it created (enough
    // for the mint claim, whose only write before the guard is the op).
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const created: string[] = [];
      const ops = prisma.tokenOperation as ReturnType<typeof table>;
      const tx = {
        ...prisma,
        tokenOperation: {
          ...ops,
          create: async (args: Parameters<typeof ops.create>[0]) => {
            const row = (await ops.create(args)) as Row;
            created.push(row.id);
            return row;
          },
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        db.tokenOperation = db.tokenOperation.filter((r) => !created.includes(r.id));
        throw e;
      }
    },
  });
  cp.getPaymentRequest.mockResolvedValue(cpRequest());
  userop.mintToken.mockResolvedValue({ txHash: TX, userOpHash: "0xuserop" });
  userop.failedBeforeSubmit.mockReturnValue(false);
});

describe("settleCardTopUp", () => {
  it("mints the paid amount 1:1 once CP reports the request signed", async () => {
    const row = seedTopUp();
    expect(await settleCardTopUp(fund, row.id)).toBe("minted");

    expect(userop.mintToken).toHaveBeenCalledTimes(1);
    expect(userop.mintToken).toHaveBeenCalledWith({
      fund,
      to: ACCOUNT,
      amount: BigInt(12_500_000), // €12.50 at 6 decimals
    });
    const op = db.tokenOperation[0];
    expect(op).toMatchObject({
      type: "MINT",
      account: ACCOUNT,
      amount: "12.50",
      memberId: "member-1",
      status: "CONFIRMED",
      txHash: TX,
    });
    expect(db.cardTopUp[0]).toMatchObject({ status: "MINTED", tokenOperationId: op.id });
    expect(resolveOrEnqueueAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "CARD_TOPUP", trigger: "CARD_TOPUP", userOpHash: "0xuserop" }),
    );
  });

  it("never mints twice under concurrent polls", async () => {
    const row = seedTopUp();
    let release!: () => void;
    userop.mintToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ txHash: TX, userOpHash: "0xuserop" });
        }),
    );
    const a = settleCardTopUp(fund, row.id);
    const b = settleCardTopUp(fund, row.id);
    await vi.waitFor(() => expect(userop.mintToken).toHaveBeenCalled());
    release();
    const results = await Promise.all([a, b]);

    expect(userop.mintToken).toHaveBeenCalledTimes(1);
    expect(db.tokenOperation).toHaveLength(1); // the loser's op rolled back
    expect(db.tokenOperation[0]).toMatchObject({ status: "CONFIRMED" });
    expect(db.cardTopUp[0]).toMatchObject({
      status: "MINTED",
      tokenOperationId: db.tokenOperation[0].id,
    });
    expect(results).toContain("minted");
    // Settling again later is a no-op.
    expect(await settleCardTopUp(fund, row.id)).toBe("minted");
    expect(userop.mintToken).toHaveBeenCalledTimes(1);
  });

  it("stays pending while CP is pending, and without an id doesn't ask CP", async () => {
    cp.getPaymentRequest.mockResolvedValue(cpRequest({ status: "pending" }));
    const row = seedTopUp();
    expect(await settleCardTopUp(fund, row.id)).toBe("pending");
    const orphan = seedTopUp({ citizenPayPaymentRequestId: null });
    expect(await settleCardTopUp(fund, orphan.id)).toBe("pending");
    expect(cp.getPaymentRequest).toHaveBeenCalledTimes(1);
    expect(userop.mintToken).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", "EXPIRED"],
    ["cancelled", "CANCELLED"],
  ] as const)("closes the top-up when CP says %s", async (cpStatus, status) => {
    cp.getPaymentRequest.mockResolvedValue(cpRequest({ status: cpStatus }));
    const row = seedTopUp();
    expect(await settleCardTopUp(fund, row.id)).toBe(cpStatus);
    expect(db.cardTopUp[0].status).toBe(status);
    expect(userop.mintToken).not.toHaveBeenCalled();
  });

  it("treats a request CP no longer knows as cancelled", async () => {
    cp.getPaymentRequest.mockResolvedValue(null);
    const row = seedTopUp();
    expect(await settleCardTopUp(fund, row.id)).toBe("cancelled");
  });

  it.each([
    ["another amount", { amountCents: 100 }],
    ["another account", { account: "0x0000000000000000000000000000000000000bad" }],
    ["an order payment", { orderId: 77 }],
  ])("refuses to mint on a signed request for %s", async (_label, over) => {
    cp.getPaymentRequest.mockResolvedValue(cpRequest(over));
    const row = seedTopUp();
    expect(await settleCardTopUp(fund, row.id)).toBe("pending");
    expect(userop.mintToken).not.toHaveBeenCalled();
  });

  it("releases the claim when the mint failed before submit, so a retry mints", async () => {
    const row = seedTopUp();
    userop.mintToken.mockRejectedValueOnce(new Error("sponsor refused"));
    userop.failedBeforeSubmit.mockReturnValueOnce(true);
    expect(await settleCardTopUp(fund, row.id)).toBe("signed");
    expect(db.cardTopUp[0]).toMatchObject({ status: "SIGNED", tokenOperationId: null });
    expect(db.tokenOperation[0]).toMatchObject({ status: "FAILED" });

    expect(await settleCardTopUp(fund, row.id)).toBe("minted");
    expect(userop.mintToken).toHaveBeenCalledTimes(2);
  });

  it("doesn't claim a mint on a fund that can't mint, and mints once it can", async () => {
    const row = seedTopUp();
    const unprovisioned = { ...fund, citizenPayPaymasterAddress: null } as TopUpFund;
    expect(await settleCardTopUp(unprovisioned, row.id)).toBe("signed");
    expect(db.tokenOperation).toHaveLength(0);
    expect(db.cardTopUp[0]).toMatchObject({ status: "SIGNED", tokenOperationId: null });
    expect(await settleCardTopUp(fund, row.id)).toBe("minted");
  });

  it("keeps the claim when the mint may be on chain (no automatic retry)", async () => {
    const row = seedTopUp();
    userop.mintToken.mockRejectedValueOnce(new Error("poll timed out"));
    expect(await settleCardTopUp(fund, row.id)).toBe("signed");
    expect(db.cardTopUp[0].tokenOperationId).toBe(db.tokenOperation[0].id);

    expect(await settleCardTopUp(fund, row.id)).toBe("signed");
    expect(userop.mintToken).toHaveBeenCalledTimes(1);
  });
});

describe("attachPaymentRequest", () => {
  it("stores the id from the bank redirect once CP confirms it is this top-up", async () => {
    const row = seedTopUp({ citizenPayPaymentRequestId: null });
    expect(await attachPaymentRequest(fund, row.id, 501)).toBe("attached");
    expect(db.cardTopUp[0].citizenPayPaymentRequestId).toBe(501);
    expect(await attachPaymentRequest(fund, row.id, 501)).toBe("already");
    expect(await attachPaymentRequest(fund, row.id, 502)).toBe("conflict");
  });

  it("rejects a request for another amount, and an unknown id", async () => {
    const row = seedTopUp({ citizenPayPaymentRequestId: null, amountCents: 50_000 });
    expect(await attachPaymentRequest(fund, row.id, 501)).toBe("mismatch");
    cp.getPaymentRequest.mockResolvedValueOnce(null);
    expect(await attachPaymentRequest(fund, row.id, 999)).toBe("unknown");
    expect(db.cardTopUp[0].citizenPayPaymentRequestId).toBeNull();
  });

  it("won't let a second top-up claim an id another one owns", async () => {
    seedTopUp({ citizenPayPaymentRequestId: 501, status: "MINTED" });
    const second = seedTopUp({ citizenPayPaymentRequestId: null });
    expect(await attachPaymentRequest(fund, second.id, 501)).toBe("conflict");
  });

  it("ignores a top-up of another fund", async () => {
    const row = seedTopUp({ fundId: "fund-2", citizenPayPaymentRequestId: null });
    expect(await attachPaymentRequest(fund, row.id, 501)).toBe("not_found");
  });
});

describe("sweepCardTopUps", () => {
  it("finishes stale top-ups and expires ones that never came back from the bank", async () => {
    const now = new Date();
    seedTopUp(); // 5 min old, signed at CP → minted
    seedTopUp({ id: "fresh", citizenPayPaymentRequestId: 502, createdAt: new Date(now.getTime() - 10_000) });
    seedTopUp({ id: "orphan", citizenPayPaymentRequestId: null, createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) });

    const stats = await sweepCardTopUps(fund, now);
    expect(stats).toMatchObject({ checked: 1, minted: 1, closed: 1, errors: 0 });
    expect(db.cardTopUp.find((r) => r.id === "fresh")?.status).toBe("PENDING");
    expect(db.cardTopUp.find((r) => r.id === "orphan")?.status).toBe("EXPIRED");
  });
});

describe("bank-sync: claimTopUpDeposit + linkTopUpDeposit", () => {
  it("recognises a deposit of a known top-up by its payment request id", async () => {
    const row = seedTopUp();
    const hit = await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true });
    expect(hit).toEqual({ topUpId: row.id, cardId: "card-1", memberId: "member-1" });
    // A different amount is not this top-up.
    expect(
      await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.00", live: true }),
    ).toBeNull();
  });

  it("adopts the orphan top-up a member never came back from", async () => {
    db.card.push({ id: "card-1", fundId: fund.id, account: ACCOUNT, memberId: "member-1" });
    const orphan = seedTopUp({ citizenPayPaymentRequestId: null, status: "EXPIRED" });
    const hit = await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true });
    expect(hit?.topUpId).toBe(orphan.id);
    expect(db.cardTopUp[0].citizenPayPaymentRequestId).toBe(501);
  });

  it("records a PAY_AND_GO top-up from the deposit when no row exists", async () => {
    db.card.push({ id: "card-1", fundId: fund.id, account: ACCOUNT, memberId: "member-1" });
    const hit = await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true });
    expect(hit).toMatchObject({ cardId: "card-1", memberId: "member-1" });
    expect(db.cardTopUp).toHaveLength(1);
    expect(db.cardTopUp[0]).toMatchObject({ citizenPayPaymentRequestId: 501, amountCents: 1250, status: "PENDING" });
  });

  it("leaves non-top-ups to regular matching", async () => {
    db.card.push({ id: "card-1", fundId: fund.id, account: ACCOUNT, memberId: "member-1" });
    cp.getPaymentRequest.mockResolvedValueOnce(cpRequest({ orderId: 9 }));
    expect(await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true })).toBeNull();
    cp.getPaymentRequest.mockResolvedValueOnce(cpRequest({ account: "0x00000000000000000000000000000000000000ff" }));
    expect(await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true })).toBeNull();
    // Backfill never asks CP or creates rows.
    expect(await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: false })).toBeNull();
    expect(cp.getPaymentRequest).toHaveBeenCalledTimes(2);
    expect(db.cardTopUp).toHaveLength(0);
  });

  it("links a minted top-up's deposit as its mint source without minting again", async () => {
    const row = seedTopUp();
    await settleCardTopUp(fund, row.id);
    const minted = await linkTopUpDeposit(fund, row.id, "btx-1", true);
    expect(minted).toBe(false);
    expect(userop.mintToken).toHaveBeenCalledTimes(1);
    expect(db.cardTopUp[0].bankTransactionId).toBe("btx-1");
    expect(db.tokenOperationSource).toEqual([
      expect.objectContaining({ bankTransactionId: "btx-1", tokenOperationId: db.tokenOperation[0].id }),
    ]);
  });

  it("mints a top-up CP had given up on once its deposit arrives", async () => {
    const row = seedTopUp({ status: "CANCELLED" });
    expect(await linkTopUpDeposit(fund, row.id, "btx-1", true)).toBe(true);
    expect(db.cardTopUp[0]).toMatchObject({ status: "MINTED", bankTransactionId: "btx-1" });
    expect(db.tokenOperationSource).toHaveLength(1);
    // A replayed ingest is a no-op.
    expect(await linkTopUpDeposit(fund, row.id, "btx-1", true)).toBe(false);
    expect(userop.mintToken).toHaveBeenCalledTimes(1);
  });

  it("only links during a backfill", async () => {
    const row = seedTopUp();
    expect(await linkTopUpDeposit(fund, row.id, "btx-1", false)).toBe(false);
    expect(db.cardTopUp[0]).toMatchObject({ status: "PENDING", bankTransactionId: "btx-1" });
    expect(userop.mintToken).not.toHaveBeenCalled();
  });
});
