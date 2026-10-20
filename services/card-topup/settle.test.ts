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
    if (key === "OR") {
      if (!(cond as Record<string, unknown>[]).some((c) => matches(row, c))) return false;
      continue;
    }
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
      if ("lte" in c && !(value != null && (value as Date) <= (c.lte as Date))) return false;
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
  attemptedUserOpHash: vi.fn(),
}));
vi.mock("@/services/token/userop", () => ({
  mintToken: userop.mintToken,
  failedBeforeSubmit: userop.failedBeforeSubmit,
  UserOpError: class UserOpError extends Error {
    constructor(
      public code: string = "submit_failed",
      message = "userop failed",
    ) {
      super(message);
    }
  },
  attemptedUserOpHash: userop.attemptedUserOpHash,
}));

const resolveOrEnqueueAnnotation = vi.hoisted(() => vi.fn());
vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation,
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({
  ANNOTATION_TRIGGERS: { cardTopUp: "CARD_TOPUP" },
}));

import { Prisma } from "@/services/db/generated/client";

import { UserOpError } from "@/services/token/userop";

import {
  attachPaymentRequest,
  claimTopUpDeposit,
  linkTopUpDeposit,
  MAX_MINT_ATTEMPTS,
  mintCardTopUp,
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
    mintTxHash: null,
    mintUserOpHash: null,
    mintAttempts: 0,
    nextMintAttemptAt: null,
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
    treasuryId: "treasury-1",
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
  userop.attemptedUserOpHash.mockReturnValue(null);
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

  it("releases the claim when the mint failed before submit, and retries after a backoff", async () => {
    const row = seedTopUp();
    const now = new Date();
    userop.mintToken.mockRejectedValueOnce(new Error("sponsor refused"));
    userop.failedBeforeSubmit.mockReturnValueOnce(true);
    expect(await settleCardTopUp(fund, row.id, now)).toBe("signed");
    expect(db.cardTopUp[0]).toMatchObject({ status: "SIGNED", tokenOperationId: null, mintAttempts: 1 });
    expect(db.tokenOperation[0]).toMatchObject({ status: "FAILED" });
    expect((db.cardTopUp[0].nextMintAttemptAt as Date).getTime()).toBe(now.getTime() + 60_000);

    // The next poll, 3 s later, waits out the backoff: no new op.
    expect(await settleCardTopUp(fund, row.id, new Date(now.getTime() + 3_000))).toBe("signed");
    expect(db.tokenOperation).toHaveLength(1);

    expect(await settleCardTopUp(fund, row.id, new Date(now.getTime() + 61_000))).toBe("minted");
    expect(userop.mintToken).toHaveBeenCalledTimes(2);
  });

  it("treats a config-class UserOpError as pre-submit (PRE_SUBMIT_CODES)", async () => {
    const row = seedTopUp();
    userop.mintToken.mockRejectedValueOnce(new UserOpError("fund_not_provisioned" as never, "no 4337 stack"));
    expect(await settleCardTopUp(fund, row.id)).toBe("signed");
    expect(userop.failedBeforeSubmit).toHaveBeenCalled();
    expect(db.cardTopUp[0]).toMatchObject({ tokenOperationId: null, mintAttempts: 1 });
    expect(db.tokenOperation[0].errorMessage).toContain("fund_not_provisioned");
  });

  it("stops retrying after MAX_MINT_ATTEMPTS and the sweep flags it", async () => {
    seedTopUp({ status: "SIGNED", mintAttempts: MAX_MINT_ATTEMPTS });
    const stats = await sweepCardTopUps(fund);
    expect(userop.mintToken).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ checked: 1, stuck: 1, minted: 0 });
  });

  it("only claims a SIGNED row (the claim's status clause)", async () => {
    const row = seedTopUp({ status: "PENDING" });
    const res = await mintCardTopUp(fund, { ...row, status: "SIGNED" } as never);
    expect(res).toBe("already_claimed");
    expect(userop.mintToken).not.toHaveBeenCalled();
    expect(db.tokenOperation).toHaveLength(0); // the op rolled back
  });

  it("doesn't claim a mint on a fund that can't mint, and mints once it can", async () => {
    const row = seedTopUp();
    const unprovisioned = { ...fund, citizenPayPaymasterAddress: null } as TopUpFund;
    expect(await settleCardTopUp(unprovisioned, row.id)).toBe("signed");
    expect(db.tokenOperation).toHaveLength(0);
    expect(db.cardTopUp[0]).toMatchObject({ status: "SIGNED", tokenOperationId: null });
    expect(await settleCardTopUp(fund, row.id)).toBe("minted");
  });

  it("keeps the claim when the mint may be on chain, and records the attempted userop", async () => {
    const row = seedTopUp();
    userop.mintToken.mockRejectedValueOnce(new Error("poll timed out"));
    userop.attemptedUserOpHash.mockReturnValueOnce("0xattempted");
    expect(await settleCardTopUp(fund, row.id)).toBe("signed");
    expect(db.cardTopUp[0]).toMatchObject({
      tokenOperationId: db.tokenOperation[0].id,
      mintUserOpHash: "0xattempted",
    });
    expect(db.tokenOperation[0]).toMatchObject({ status: "FAILED" });
    expect(db.tokenOperation[0].errorMessage).toContain("[userOp 0xattempted]");

    expect(await settleCardTopUp(fund, row.id)).toBe("signed");
    expect(userop.mintToken).toHaveBeenCalledTimes(1);
  });

  it("never fails a submitted mint on bookkeeping errors; the sweep repairs the op", async () => {
    const row = seedTopUp();
    const ops = prisma.tokenOperation as { update: ReturnType<typeof vi.fn> };
    ops.update.mockRejectedValueOnce(new Error("db blip"));
    resolveOrEnqueueAnnotation.mockRejectedValueOnce(new Error("bundler down"));
    expect(await settleCardTopUp(fund, row.id)).toBe("minted");
    expect(db.cardTopUp[0]).toMatchObject({ status: "MINTED", mintTxHash: TX });
    expect(db.tokenOperation[0]).toMatchObject({ status: "PENDING" }); // not FAILED

    await sweepCardTopUps(fund);
    expect(db.tokenOperation[0]).toMatchObject({ status: "CONFIRMED", txHash: TX });
    expect(userop.mintToken).toHaveBeenCalledTimes(1);
  });

  it("finishes a claimed row whose MINTED write failed, without minting again", async () => {
    const row = seedTopUp();
    const topUps = prisma.cardTopUp as { updateMany: ReturnType<typeof vi.fn> };
    const real = topUps.updateMany.getMockImplementation() as (args: unknown) => Promise<unknown>;
    topUps.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (args.data.status === "MINTED" && args.data.mintTxHash) throw new Error("db blip");
      return real(args);
    });
    expect(await settleCardTopUp(fund, row.id)).toBe("signed");
    expect(db.tokenOperation[0]).toMatchObject({ status: "CONFIRMED", txHash: TX });
    topUps.updateMany.mockImplementation(real);

    expect(await settleCardTopUp(fund, row.id)).toBe("minted");
    expect(db.cardTopUp[0]).toMatchObject({ status: "MINTED", mintTxHash: TX });
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

  it.each([
    ["another treasury's request", "treasury-other"],
    ["a response without treasuryId (before CP api#224)", null],
  ])("rejects %s", async (_label, treasuryId) => {
    cp.getPaymentRequest.mockResolvedValue(cpRequest({ treasuryId }));
    const row = seedTopUp({ citizenPayPaymentRequestId: null });
    expect(await attachPaymentRequest(fund, row.id, 501)).toBe("mismatch");
    // …and a row that somehow has the id never mints on it either.
    const withId = seedTopUp({ citizenPayPaymentRequestId: 777 });
    expect(await settleCardTopUp(fund, withId.id)).toBe("pending");
    expect(userop.mintToken).not.toHaveBeenCalled();
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

  it("ages out old PENDING rows but never SIGNED ones (max-age exemption)", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    seedTopUp({ id: "old-pending", createdAt: old, updatedAt: old });
    seedTopUp({ id: "old-signed", status: "SIGNED", createdAt: old, updatedAt: old });
    const stats = await sweepCardTopUps(fund, now);
    expect(cp.getPaymentRequest).not.toHaveBeenCalled(); // old PENDING not re-asked
    expect(stats.minted).toBe(1);
    expect(db.cardTopUp.find((r) => r.id === "old-signed")?.status).toBe("MINTED");
    expect(db.cardTopUp.find((r) => r.id === "old-pending")?.status).toBe("PENDING");
  });

  it("flags minted top-ups whose deposit never showed up", async () => {
    const now = new Date();
    const sixDays = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    seedTopUp({ status: "MINTED", createdAt: sixDays, bankTransactionId: null });
    seedTopUp({ status: "MINTED", createdAt: sixDays, bankTransactionId: "btx-ok" });
    seedTopUp({ status: "MINTED", createdAt: new Date(now.getTime() - 60 * 60 * 1000) });
    expect((await sweepCardTopUps(fund, now)).unreconciled).toBe(1);
  });
});

describe("bank-sync: claimTopUpDeposit + linkTopUpDeposit", () => {
  it("recognises a deposit of a known top-up by its payment request id", async () => {
    const row = seedTopUp();
    const hit = await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true });
    expect(hit).toEqual({ kind: "topup", topUpId: row.id, cardId: "card-1", memberId: "member-1" });
  });

  it("holds a known top-up's deposit whose amount differs (no fall-through to matching)", async () => {
    seedTopUp();
    const hit = await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.00", live: true });
    expect(hit).toMatchObject({ kind: "hold", reason: "amount_mismatch" });
    expect(hit?.kind === "hold" && hit.note).toContain("cp-501");
  });

  it("holds a second deposit for a top-up that already has one", async () => {
    seedTopUp({ status: "MINTED", bankTransactionId: "btx-1" });
    expect(
      await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true, bankTransactionId: "btx-2" }),
    ).toMatchObject({ kind: "hold", reason: "duplicate_deposit" });
    // The same deposit re-ingested is still its own.
    expect(
      await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true, bankTransactionId: "btx-1" }),
    ).toMatchObject({ kind: "topup" });
  });

  it("adopts the orphan top-up a member never came back from", async () => {
    db.card.push({ id: "card-1", fundId: fund.id, account: ACCOUNT, memberId: "member-1" });
    const orphan = seedTopUp({ citizenPayPaymentRequestId: null, status: "EXPIRED" });
    const hit = await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true });
    expect(hit).toMatchObject({ kind: "topup", topUpId: orphan.id });
    expect(db.cardTopUp[0].citizenPayPaymentRequestId).toBe(501);
  });

  it("records a PAY_AND_GO top-up from the deposit when no row exists", async () => {
    db.card.push({ id: "card-1", fundId: fund.id, account: ACCOUNT, memberId: "member-1" });
    const hit = await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true });
    expect(hit).toMatchObject({ kind: "topup", cardId: "card-1", memberId: "member-1" });
    expect(db.cardTopUp).toHaveLength(1);
    expect(db.cardTopUp[0]).toMatchObject({ citizenPayPaymentRequestId: 501, amountCents: 1250, status: "PENDING" });
  });

  it("holds a top-up request for our card that CP can't tie to this treasury", async () => {
    db.card.push({ id: "card-1", fundId: fund.id, account: ACCOUNT, memberId: "member-1" });
    cp.getPaymentRequest.mockResolvedValueOnce(cpRequest({ treasuryId: null }));
    expect(
      await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true }),
    ).toMatchObject({ kind: "hold", reason: "unverified" });
    cp.getPaymentRequest.mockResolvedValueOnce(cpRequest({ amountCents: 999 }));
    expect(
      await claimTopUpDeposit(fund, { paymentRequestId: 501, amount: "12.50", live: true }),
    ).toMatchObject({ kind: "hold", reason: "amount_mismatch" });
    expect(db.cardTopUp).toHaveLength(0);
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
    expect(await linkTopUpDeposit(fund, row.id, "btx-1", true)).toEqual({ linked: true, minted: false });
    expect(userop.mintToken).toHaveBeenCalledTimes(1);
    expect(db.cardTopUp[0].bankTransactionId).toBe("btx-1");
    expect(db.tokenOperationSource).toEqual([
      expect.objectContaining({ bankTransactionId: "btx-1", tokenOperationId: db.tokenOperation[0].id }),
    ]);
  });

  it("refuses to attach a second deposit as a source of the existing mint", async () => {
    const row = seedTopUp();
    await settleCardTopUp(fund, row.id);
    await linkTopUpDeposit(fund, row.id, "btx-1", true);
    expect(await linkTopUpDeposit(fund, row.id, "btx-2", true)).toEqual({ linked: false, minted: false });
    expect(db.tokenOperationSource).toHaveLength(1);
  });

  it("mints a top-up CP had given up on once its deposit arrives", async () => {
    const row = seedTopUp({ status: "CANCELLED" });
    expect(await linkTopUpDeposit(fund, row.id, "btx-1", true)).toEqual({ linked: true, minted: true });
    expect(db.cardTopUp[0]).toMatchObject({ status: "MINTED", bankTransactionId: "btx-1" });
    expect(db.tokenOperationSource).toHaveLength(1);
    // A replayed ingest is a no-op.
    expect(await linkTopUpDeposit(fund, row.id, "btx-1", true)).toEqual({ linked: true, minted: false });
    expect(userop.mintToken).toHaveBeenCalledTimes(1);
  });

  it("only links during a backfill", async () => {
    const row = seedTopUp();
    expect(await linkTopUpDeposit(fund, row.id, "btx-1", false)).toEqual({ linked: true, minted: false });
    expect(db.cardTopUp[0]).toMatchObject({ status: "PENDING", bankTransactionId: "btx-1" });
    expect(userop.mintToken).not.toHaveBeenCalled();
  });
});
