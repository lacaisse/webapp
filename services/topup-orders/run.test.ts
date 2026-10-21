// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitizenPayApiError } from "@/services/citizenpay/api";
import type { CitizenPayClient } from "@/services/citizenpay/client-interface";
import type { TopUpOrder } from "@/services/citizenpay/types";
import { UserOpError } from "@/services/token/userop";

// The runner against an in-memory TokenOperation store, a scripted CP client
// and a scripted mint: claim → op → userop → report, and what each failure
// leaves behind for the next tick.

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown> & { id: string };
const db = vi.hoisted(() => ({
  tokenOperation: [] as Row[],
  fund: [] as Row[],
  seq: 0,
}));

vi.mock("@/services/db/prisma", () => ({
  prisma: {
    tokenOperation: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.tokenOperation.filter(
          (r) =>
            r.fundId === where.fundId &&
            r.type === where.type &&
            (where.topUpOrderId as { in: number[] }).in.includes(
              r.topUpOrderId as number,
            ),
        ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `op-${++db.seq}`, txHash: null, ...data };
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

import { runTopUpOrders, type TopUpRunFund } from "./run";

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
type Moved = { txHash: Hex; userOpHash: Hex };
const okMint = vi.fn(async (): Promise<Moved> => ({ txHash: "0xmint", userOpHash: "0xuo1" }));
const okBurn = vi.fn(async (): Promise<Moved> => ({ txHash: "0xburn", userOpHash: "0xuo2" }));

beforeEach(() => {
  db.tokenOperation.length = 0;
  db.fund.length = 0;
  db.seq = 0;
  okMint.mockClear();
  okBurn.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("runTopUpOrders", () => {
  it("claims, mints the cents to the card, confirms the op and reports the hash", async () => {
    const { client: cp, calls } = client({ pending: [order(1)] });
    const stats = await runTopUpOrders(fund, { client: cp, mint: okMint, burn: okBurn });

    expect(stats).toMatchObject({ listed: 1, minted: 1, failed: 0, errors: [] });
    expect(calls).toEqual([
      "list:pending",
      "claim:1",
      "credit:1:c-1:0xmint",
      "list:reversal_pending",
    ]);
    expect(okMint).toHaveBeenCalledWith({ fund, to: "0xKNOWN", amount: BigInt(12_500_000) });
    expect(db.tokenOperation[0]).toMatchObject({
      fundId: "f1",
      type: "TOPUP",
      memberId: "m1",
      account: "0xKNOWN",
      amount: "12.50",
      status: "CONFIRMED",
      txHash: "0xmint",
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

  it("burns a reversal and reports it with reverse", async () => {
    const { client: cp, calls } = client({
      reversal: [order(2, { state: "reversal_pending", cardAddress: "0xother" })],
    });
    const stats = await runTopUpOrders(fund, { client: cp, mint: okMint, burn: okBurn });
    expect(stats).toMatchObject({ reversed: 1, minted: 0 });
    expect(okBurn).toHaveBeenCalledWith({ fund, from: "0xother", amount: BigInt(12_500_000) });
    expect(calls).toContain("reverse:2:c-2:0xburn");
    expect(db.tokenOperation[0]).toMatchObject({
      type: "TOPUP_REVERSAL",
      memberId: null,
      status: "CONFIRMED",
    });
  });

  it("skips an order whose claim is held elsewhere, without touching the chain", async () => {
    const { client: cp } = client({
      pending: [order(1)],
      claim: async () => {
        throw refuse("claim in progress");
      },
    });
    const stats = await runTopUpOrders(fund, { client: cp, mint: okMint, burn: okBurn });
    expect(stats).toMatchObject({ skipped: 1, minted: 0, failed: 0 });
    expect(okMint).not.toHaveBeenCalled();
    expect(db.tokenOperation).toHaveLength(0);
  });

  it("a pre-submit userop failure marks the op FAILED, so the next tick retries", async () => {
    const { client: cp, calls } = client({ pending: [order(1)] });
    const mint = vi.fn(async () => {
      throw new UserOpError("config", "bundler url missing");
    });
    const stats = await runTopUpOrders(fund, { client: cp, mint, burn: okBurn });
    expect(stats).toMatchObject({ failed: 1, minted: 0 });
    expect(stats.errors[0]).toMatch(/order 1: config/);
    expect(db.tokenOperation[0]).toMatchObject({ status: "FAILED" });
    expect(calls.some((c) => c.startsWith("credit:"))).toBe(false);
    expect(db.fund[0]).toMatchObject({ topUpOrdersRunFailed: 1 });
  });

  it("a failure that may be on chain keeps the op PENDING, and the next tick leaves it alone", async () => {
    const { client: cp } = client({ pending: [order(1)] });
    const mint = vi.fn(async () => {
      throw new UserOpError("submit_failed", "bundler timed out");
    });
    await runTopUpOrders(fund, { client: cp, mint, burn: okBurn });
    expect(db.tokenOperation[0]).toMatchObject({ status: "PENDING" });
    expect(String(db.tokenOperation[0].errorMessage)).toContain("submit_failed");

    const second = await runTopUpOrders(fund, { client: cp, mint: okMint, burn: okBurn });
    expect(second).toMatchObject({ skipped: 1, minted: 0 });
    expect(okMint).not.toHaveBeenCalled();
    expect(db.tokenOperation).toHaveLength(1);
  });

  it("a failed report is resent next tick without minting again", async () => {
    let reportFails = true;
    const { client: cp, calls } = client({
      pending: [order(1)],
      credit: async () => {
        if (reportFails) throw new Error("cp down");
      },
    });
    const first = await runTopUpOrders(fund, { client: cp, mint: okMint, burn: okBurn });
    expect(first).toMatchObject({ minted: 1, failed: 1 });
    expect(db.tokenOperation[0]).toMatchObject({ status: "CONFIRMED", txHash: "0xmint" });

    reportFails = false;
    const second = await runTopUpOrders(fund, { client: cp, mint: okMint, burn: okBurn });
    expect(second).toMatchObject({ reported: 1, minted: 0, failed: 0 });
    expect(okMint).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.startsWith("credit:1:"))).toEqual([
      "credit:1:c-1:0xmint",
      "credit:1:c-1:0xmint",
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
    const stats = await runTopUpOrders(fund, { client: cp, mint: okMint, burn: okBurn });
    expect(stats).toMatchObject({ minted: 1, failed: 0 });
  });

  it("one order's failure does not block the others", async () => {
    const { client: cp } = client({
      pending: [order(1), order(2, { cardAddress: "0xother" })],
    });
    const mint = vi.fn(async ({ to }: { to: string }) => {
      if (to === "0xKNOWN") throw new UserOpError("config", "no");
      return { txHash: "0xok", userOpHash: "0xuo" } as Moved;
    });
    const stats = await runTopUpOrders(
      fund,
      { client: cp, mint: mint as unknown as typeof okMint, burn: okBurn },
    );
    expect(stats).toMatchObject({ failed: 1, minted: 1 });
    expect(mint).toHaveBeenCalledTimes(2);
    expect(db.tokenOperation.map((r) => r.status)).toEqual(["FAILED", "CONFIRMED"]);
  });

  it("does nothing for a fund that cannot mint, and says so", async () => {
    const { client: cp, calls } = client({ pending: [order(1)] });
    const stats = await runTopUpOrders(
      { ...fund, tokenMinterSmartAccountAddress: null },
      { client: cp, mint: okMint, burn: okBurn },
    );
    expect(calls).toEqual([]);
    expect(stats.errors[0]).toMatch(/cannot mint/);
  });
});
