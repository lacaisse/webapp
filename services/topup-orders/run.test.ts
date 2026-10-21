// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitizenPayApiError } from "@/services/citizenpay/api";
import type { CitizenPayClient } from "@/services/citizenpay/client-interface";
import type { TopUpOrder } from "@/services/citizenpay/types";
import { Prisma } from "@/services/db/generated/client";
import { UserOpError, type UserOpResolution } from "@/services/token/userop";

// The runner against an in-memory TokenOperation store, a scripted CP client,
// a scripted bundler submit and a scripted userop resolution: claim → op →
// submit → report at once, then what each failure leaves for the next tick.

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown> & { id: string };
const db = vi.hoisted(() => ({
  tokenOperation: [] as Row[],
  fund: [] as Row[],
  seq: 0,
  // txHash values that collide on update (simulates the unique index).
  takenTx: new Set<string>(),
}));

vi.mock("@/services/db/prisma", () => ({
  prisma: {
    tokenOperation: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.tokenOperation.filter((r) => {
          if (r.fundId !== where.fundId) return false;
          const type = where.type as string | { in: string[] };
          if (typeof type === "string" ? r.type !== type : !type.in.includes(r.type as string)) return false;
          if (where.status && r.status !== where.status) return false;
          if (where.txHash && r.txHash == null) return false;
          const ids = where.topUpOrderId as { in: number[] } | undefined;
          if (ids && !ids.in.includes(r.topUpOrderId as number)) return false;
          return true;
        }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `op-${++db.seq}`,
          txHash: null,
          userOpHash: null,
          submittedAt: new Date("2026-10-21T10:00:00Z"),
          ...data,
        };
        db.tokenOperation.push(row);
        return { id: row.id };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = db.tokenOperation.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        if (typeof data.txHash === "string" && db.takenTx.has(data.txHash)) {
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        Object.assign(row, data);
        return row;
      },
    },
    card: {
      findFirst: async ({ where }: { where: { account: { equals: string } } }) =>
        where.account.equals.toLowerCase() === "0xknown" ? { memberId: "m1" } : null,
    },
    fund: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        db.fund.push({ id: "f1", ...data });
        return data;
      },
    },
  },
}));

vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation: vi.fn(async () => {}),
}));

import {
  runTopUpOrders,
  STALE_SUBMISSION_MS,
  type TopUpRunFund,
} from "./run";

const NOW = new Date("2026-10-21T10:00:30Z");

const fund: TopUpRunFund = {
  id: "f1",
  citizenPayFundId: "t1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "enc",
  tokenAddress: "0xtoken",
  tokenChainId: 100,
  tokenDecimals: 6,
  tokenMinterPrivateKeyEnc: "enc",
  tokenMinterEoaAddress: "0xeoa",
  tokenMinterSmartAccountAddress: "0xsafe",
  citizenPayEntrypointAddress: "0xep",
  citizenPayAccountFactoryAddress: "0xfactory",
  citizenPayPaymasterAddress: "0xpm",
  citizenPayPaymasterType: "cp",
};

function order(orderId: number, overrides: Partial<TopUpOrder> = {}): TopUpOrder {
  return {
    orderId,
    serial: `S-${orderId}`,
    cardAddress: "0xKNOWN",
    amountCents: 1250,
    token: "0xtoken",
    placeId: "p1",
    placeName: "Bar du Coin",
    paidAt: new Date("2026-10-21T09:58:00Z"),
    state: "pending",
    claimedAt: null,
    ...overrides,
  };
}

function refuse(message: string) {
  return new CitizenPayApiError(message, 409, { error: message });
}

type Script = {
  pending?: TopUpOrder[];
  reversal?: TopUpOrder[];
  claim?: (orderId: number) => Promise<{ claimId: string; expiresAt: Date | null }>;
  credit?: (orderId: number, r: { claimId: string; txHash: string }) => Promise<void>;
  reverse?: (orderId: number, r: { claimId: string; txHash: string }) => Promise<void>;
};

function client(s: Script) {
  const calls: string[] = [];
  const c = {
    listTopUpOrders: vi.fn(async (state: string) => {
      calls.push(`list:${state}`);
      return (state === "pending" ? s.pending : s.reversal) ?? [];
    }),
    claimTopUpOrder: vi.fn(async (orderId: number) => {
      calls.push(`claim:${orderId}`);
      return s.claim ? s.claim(orderId) : { claimId: `c-${orderId}`, expiresAt: null };
    }),
    creditTopUpOrder: vi.fn(async (orderId: number, r: { claimId: string; txHash: string }) => {
      calls.push(`credit:${orderId}:${r.claimId}:${r.txHash}`);
      if (s.credit) await s.credit(orderId, r);
    }),
    reverseTopUpOrder: vi.fn(async (orderId: number, r: { claimId: string; txHash: string }) => {
      calls.push(`reverse:${orderId}:${r.claimId}:${r.txHash}`);
      if (s.reverse) await s.reverse(orderId, r);
    }),
  };
  return { client: c as unknown as CitizenPayClient, calls };
}

type Hex = `0x${string}`;
const okMint = vi.fn(async (): Promise<{ userOpHash: Hex }> => ({ userOpHash: "0xuo-mint" }));
const okBurn = vi.fn(async (): Promise<{ userOpHash: Hex }> => ({ userOpHash: "0xuo-burn" }));
// Default resolution: nothing has settled yet.
const unresolved = vi.fn(async (): Promise<UserOpResolution> => ({ txHash: null, status: "pending" }));
const settled = (tx: Hex) =>
  vi.fn(async (): Promise<UserOpResolution> => ({ txHash: tx, status: "success" }));

const base = { submitMint: okMint, submitBurn: okBurn, resolve: unresolved, now: NOW };

beforeEach(() => {
  db.tokenOperation.length = 0;
  db.fund.length = 0;
  db.seq = 0;
  db.takenTx.clear();
  okMint.mockClear();
  okBurn.mockClear();
  unresolved.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("runTopUpOrders", () => {
  it("claims, submits the mint, and reports the userop hash to CP at once", async () => {
    const { client: cp, calls } = client({ pending: [order(1)] });
    const stats = await runTopUpOrders(fund, { ...base, client: cp });

    expect(stats).toMatchObject({ listed: 1, minted: 1, failed: 0, errors: [] });
    expect(calls).toEqual([
      "list:pending",
      "claim:1",
      "credit:1:c-1:0xuo-mint",
      "list:reversal_pending",
    ]);
    expect(okMint).toHaveBeenCalledWith({ fund, to: "0xKNOWN", amount: BigInt(12_500_000) });
    // Accepted by the bundler, not yet mined: PENDING with the userop hash.
    expect(db.tokenOperation[0]).toMatchObject({
      fundId: "f1",
      type: "TOPUP",
      memberId: "m1",
      account: "0xKNOWN",
      amount: "12.50",
      status: "PENDING",
      txHash: "0xuo-mint",
      userOpHash: "0xuo-mint",
      topUpOrderId: 1,
      topUpSerial: "S-1",
      topUpPlaceName: "Bar du Coin",
    });
    expect(db.fund[0]).toMatchObject({
      topUpOrdersRunMinted: 1,
      topUpOrdersRunFailed: 0,
      topUpOrdersRunError: null,
    });
  });

  it("the next tick resolves the submission to the mined tx and keeps the userop hash", async () => {
    const { client: cp } = client({ pending: [order(1)] });
    await runTopUpOrders(fund, { ...base, client: cp });

    const { client: cp2, calls } = client({});
    const stats = await runTopUpOrders(fund, { ...base, client: cp2, resolve: settled("0xmined") });
    expect(stats).toMatchObject({ confirmed: 1, minted: 0, failed: 0 });
    expect(db.tokenOperation[0]).toMatchObject({
      status: "CONFIRMED",
      txHash: "0xmined",
      userOpHash: "0xuo-mint",
    });
    expect(calls).toEqual(["list:pending", "list:reversal_pending"]);
  });

  it("a mined tx shared with another op keeps the userop hash as txHash", async () => {
    const { client: cp } = client({ pending: [order(1)] });
    await runTopUpOrders(fund, { ...base, client: cp });
    db.takenTx.add("0xmined");
    const stats = await runTopUpOrders(fund, { ...base, client: client({}).client, resolve: settled("0xmined") });
    expect(stats).toMatchObject({ confirmed: 1, failed: 0 });
    expect(db.tokenOperation[0]).toMatchObject({ status: "CONFIRMED", txHash: "0xuo-mint" });
  });

  it("a reverted or long-unresolved submission fails the op and is reported as a failure", async () => {
    const { client: cp } = client({ pending: [order(1), order(2, { cardAddress: "0xother" })] });
    const submitMint = vi.fn(async ({ to }: { to: string }): Promise<{ userOpHash: Hex }> => ({
      userOpHash: to === "0xKNOWN" ? "0xuo-mint" : "0xuo-other",
    }));
    await runTopUpOrders(fund, { ...base, client: cp, submitMint });

    const reverted = vi.fn(async (_c: number, h: string): Promise<UserOpResolution> =>
      h === "0xuo-mint" ? { txHash: "0xdead", status: "reverted" } : { txHash: null, status: "pending" },
    );
    const first = await runTopUpOrders(fund, { ...base, client: client({}).client, resolve: reverted });
    expect(first).toMatchObject({ failed: 1, confirmed: 0 });
    expect(db.tokenOperation.map((r) => r.status)).toEqual(["FAILED", "PENDING"]);
    expect(first.errors[0]).toMatch(/order 1: userop reverted/);

    const later = new Date(NOW.getTime() + STALE_SUBMISSION_MS + 1);
    const second = await runTopUpOrders(fund, { ...base, client: client({}).client, now: later });
    expect(second).toMatchObject({ failed: 1 });
    expect(db.tokenOperation[1]).toMatchObject({ status: "FAILED" });
    expect(String(db.tokenOperation[1].errorMessage)).toMatch(/not settled/);
  });

  it("burns a reversal and reports it with reverse", async () => {
    const { client: cp, calls } = client({
      reversal: [order(2, { state: "reversal_pending", cardAddress: "0xother" })],
    });
    const stats = await runTopUpOrders(fund, { ...base, client: cp });
    expect(stats).toMatchObject({ reversed: 1, minted: 0 });
    expect(okBurn).toHaveBeenCalledWith({ fund, from: "0xother", amount: BigInt(12_500_000) });
    expect(calls).toContain("reverse:2:c-2:0xuo-burn");
    expect(db.tokenOperation[0]).toMatchObject({
      type: "TOPUP_REVERSAL",
      memberId: null,
      status: "PENDING",
      txHash: "0xuo-burn",
    });
  });

  it("skips an order whose claim is held elsewhere, without touching the bundler", async () => {
    const { client: cp } = client({
      pending: [order(1)],
      claim: async () => {
        throw refuse("claim in progress");
      },
    });
    const stats = await runTopUpOrders(fund, { ...base, client: cp });
    expect(stats).toMatchObject({ skipped: 1, minted: 0, failed: 0 });
    expect(okMint).not.toHaveBeenCalled();
    expect(db.tokenOperation).toHaveLength(0);
  });

  it("a refused submission marks the op FAILED and reports nothing; the next tick retries", async () => {
    const { client: cp, calls } = client({ pending: [order(1)] });
    const submitMint = vi.fn(async (): Promise<{ userOpHash: Hex }> => {
      throw new UserOpError("submit_failed", "bundler: AA21 didn't pay prefund");
    });
    const stats = await runTopUpOrders(fund, { ...base, client: cp, submitMint });
    expect(stats).toMatchObject({ failed: 1, minted: 0 });
    expect(stats.errors[0]).toMatch(/order 1: submit_failed/);
    expect(db.tokenOperation[0]).toMatchObject({ status: "FAILED", txHash: null });
    expect(calls.some((c) => c.startsWith("credit:"))).toBe(false);
    expect(db.fund[0]).toMatchObject({ topUpOrdersRunFailed: 1 });

    const second = await runTopUpOrders(fund, { ...base, client: cp });
    expect(second).toMatchObject({ minted: 1 });
    expect(db.tokenOperation).toHaveLength(2);
  });

  it("a failed report is resent once the userop settled, without minting again", async () => {
    let reportFails = true;
    const { client: cp, calls } = client({
      pending: [order(1)],
      credit: async () => {
        if (reportFails) throw new Error("cp down");
      },
    });
    const first = await runTopUpOrders(fund, { ...base, client: cp });
    expect(first).toMatchObject({ minted: 1, failed: 1 });

    // Still unresolved: left alone (CP may have taken the report after all).
    reportFails = false;
    const second = await runTopUpOrders(fund, { ...base, client: cp });
    expect(second).toMatchObject({ skipped: 1, minted: 0, reported: 0 });

    // Settled: the report goes out again, with the userop hash.
    const third = await runTopUpOrders(fund, { ...base, client: cp, resolve: settled("0xmined") });
    expect(third).toMatchObject({ confirmed: 1, reported: 1, minted: 0, failed: 0 });
    expect(okMint).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.startsWith("credit:1:"))).toEqual([
      "credit:1:c-1:0xuo-mint",
      "credit:1:c-1:0xuo-mint",
    ]);
    expect(db.tokenOperation).toHaveLength(1);
  });

  it("treats 'already credited' on the report as done", async () => {
    const { client: cp } = client({
      pending: [order(1)],
      credit: async () => {
        throw refuse("already credited");
      },
    });
    const stats = await runTopUpOrders(fund, { ...base, client: cp });
    expect(stats).toMatchObject({ minted: 1, failed: 0 });
  });

  it("one order's failure does not block the others", async () => {
    const { client: cp } = client({
      pending: [order(1), order(2, { cardAddress: "0xother" })],
    });
    const submitMint = vi.fn(async ({ to }: { to: string }): Promise<{ userOpHash: Hex }> => {
      if (to === "0xKNOWN") throw new UserOpError("config", "no");
      return { userOpHash: "0xuo-ok" };
    });
    const stats = await runTopUpOrders(fund, { ...base, client: cp, submitMint });
    expect(stats).toMatchObject({ failed: 1, minted: 1 });
    expect(submitMint).toHaveBeenCalledTimes(2);
    expect(db.tokenOperation.map((r) => r.status)).toEqual(["FAILED", "PENDING"]);
  });

  it("does nothing for a fund that cannot mint, and says so", async () => {
    const { client: cp, calls } = client({ pending: [order(1)] });
    const stats = await runTopUpOrders(
      { ...fund, tokenMinterSmartAccountAddress: null },
      { ...base, client: cp },
    );
    expect(calls).toEqual([]);
    expect(stats.errors[0]).toMatch(/cannot mint/);
  });
});
