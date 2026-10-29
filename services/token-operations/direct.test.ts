// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// burnDirect's `broadcast` flag: whether a failed burn may be on chain. The
// userop pipeline and the database are faked; userop.test.ts covers where the
// "failed before submit" tag itself comes from.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const prisma = vi.hoisted(() => ({
  tokenOperation: { create: vi.fn(), update: vi.fn() },
  fund: { update: vi.fn() },
  fundSafe: { findFirst: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const userop = vi.hoisted(() => ({
  burnFromToken: vi.fn(),
  mintToken: vi.fn(),
  failedBeforeSubmit: vi.fn(),
  attemptedUserOpHash: vi.fn(),
}));
// Same shape as the real UserOpError: `code`, plus `txHash` for a tx that
// landed and reverted.
const UserOpError = vi.hoisted(
  () =>
    class UserOpError extends Error {
      txHash?: string;
      constructor(
        public readonly code: string,
        message: string,
        details: { txHash?: string } = {},
      ) {
        super(message);
        this.txHash = details.txHash;
      }
    },
);
vi.mock("@/services/token/userop", () => ({ ...userop, UserOpError }));

const resolveOrEnqueueAnnotation = vi.hoisted(() => vi.fn());
vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation,
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({
  ANNOTATION_TRIGGERS: {
    adminDirectBurn: "ADMIN_DIRECT_BURN",
    adminDirectMint: "ADMIN_DIRECT_MINT",
  },
}));

import { burnDirect, mintDirect, type DirectOpContext } from "./direct";

const TX = `0x${"ab".repeat(32)}`;
const SAFE = "0x5555555555555555555555555555555555555555";
const ctx = {
  fund: {
    id: "fund-1",
    tokenAddress: "0x3333333333333333333333333333333333333333",
    tokenDecimals: 6,
    tokenChainId: 100,
    tokenMinterSmartAccountAddress: SAFE,
    tokenMintEnabledAt: null,
  },
  userId: "user-1",
  t: (key: string, values?: Record<string, string | number>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
} as unknown as DirectOpContext;
const input = { from: "0x9999999999999999999999999999999999999999", amount: "12.50" };
const audit = { trigger: "PAYOUT_BURN" };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tokenOperation.create.mockResolvedValue({ id: "op-1" });
  prisma.tokenOperation.update.mockResolvedValue({});
  prisma.fund.update.mockResolvedValue({});
  prisma.fundSafe.findFirst.mockResolvedValue(null);
  userop.burnFromToken.mockResolvedValue({ txHash: TX, userOpHash: "0xuserop" });
  userop.mintToken.mockResolvedValue({ txHash: TX, userOpHash: "0xuserop" });
  userop.failedBeforeSubmit.mockReturnValue(false);
  userop.attemptedUserOpHash.mockReturnValue(null);
});

describe("burnDirect — broadcast", () => {
  it("is false for validation failures (nothing attempted)", async () => {
    const res = await burnDirect(ctx, { ...input, from: "nope" }, audit);
    expect(res).toMatchObject({ broadcast: false });
    expect(userop.burnFromToken).not.toHaveBeenCalled();
  });

  it("is false for a missing token config", async () => {
    const res = await burnDirect(
      { ...ctx, fund: { ...ctx.fund, tokenAddress: null } },
      input,
      audit,
    );
    expect(res).toEqual({ error: "tokenOps.errors.tokenNotConfigured", broadcast: false });
  });

  it("is false when the pipeline tagged the error as before submit", async () => {
    userop.burnFromToken.mockRejectedValueOnce(new Error("sponsor refused"));
    userop.failedBeforeSubmit.mockReturnValueOnce(true);
    expect(await burnDirect(ctx, input, audit)).toEqual({
      error: "tokenOps.errors.submitFailed",
      broadcast: false,
    });
  });

  it("is true for an untagged pipeline error", async () => {
    userop.burnFromToken.mockRejectedValueOnce(new Error("poll timed out"));
    expect(await burnDirect(ctx, input, audit)).toEqual({
      error: "tokenOps.errors.submitFailed",
      broadcast: true,
    });
  });

  it("carries the attempted userOp hash and stores it on the failed row", async () => {
    const userOp = `0x${"cd".repeat(32)}`;
    userop.burnFromToken.mockRejectedValueOnce(new Error("poll timed out"));
    userop.attemptedUserOpHash.mockReturnValueOnce(userOp);
    expect(await burnDirect(ctx, input, audit)).toEqual({
      error: "tokenOps.errors.submitFailed",
      broadcast: true,
      userOpHash: userOp,
    });
    expect(prisma.tokenOperation.update).toHaveBeenLastCalledWith({
      where: { id: "op-1" },
      data: { status: "FAILED", errorMessage: `Error: poll timed out [userOp ${userOp}]` },
    });
  });

  it("is true, with the hashes, when the burn confirmed but bookkeeping failed", async () => {
    resolveOrEnqueueAnnotation.mockRejectedValueOnce(new Error("db hiccup"));
    expect(await burnDirect(ctx, input, audit)).toEqual({
      error: "tokenOps.errors.submitFailed",
      broadcast: true,
      txHash: TX,
      userOpHash: "0xuserop",
    });
  });

  it("returns the hashes on success", async () => {
    expect(await burnDirect(ctx, input, audit)).toEqual({
      ok: true,
      txHash: TX,
      userOpHash: "0xuserop",
    });
  });
  it("burnDirect refuses a from address that is a fund Safe", async () => {
    prisma.fundSafe.findFirst.mockResolvedValueOnce({ id: "safe-1" });
    const from = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    expect(
      await burnDirect(ctx, { from, amount: "12.50", note: "drain" }),
    ).toEqual({
      error: "tokenOps.errors.fromIsSafe",
      field: "from",
      broadcast: false,
    });
    expect(prisma.fundSafe.findFirst).toHaveBeenCalledWith({
      where: {
        fundId: "fund-1",
        address: { equals: from, mode: "insensitive" },
      },
      select: { id: true },
    });
    expect(prisma.tokenOperation.create).not.toHaveBeenCalled();
    expect(userop.burnFromToken).not.toHaveBeenCalled();
  });
});

describe("mintDirect — settlement", () => {
  const mintInput = { to: "0x9999999999999999999999999999999999999999", amount: "1.00" };
  const mintAudit = { trigger: "ORDER_SETTLEMENT_MINT" };

  it("records FAILED with the tx hash when the tx landed and reverted", async () => {
    userop.mintToken.mockRejectedValueOnce(
      new UserOpError("tx_failed", "UserOp 0xaa tx reverted on chain (receipt status 0x0)", {
        txHash: TX,
      }),
    );
    expect(await mintDirect(ctx, mintInput, mintAudit)).toEqual({
      error: "tokenOps.errors.submitFailed",
    });
    expect(prisma.tokenOperation.update).toHaveBeenLastCalledWith({
      where: { id: "op-1" },
      data: {
        status: "FAILED",
        errorMessage: "tx_failed: UserOp 0xaa tx reverted on chain (receipt status 0x0)",
        txHash: TX,
      },
    });
    expect(resolveOrEnqueueAnnotation).not.toHaveBeenCalled();
    expect(prisma.fund.update).not.toHaveBeenCalled();
  });

  it("names the minter Safe and MINTER_ROLE when the role is missing", async () => {
    userop.mintToken.mockRejectedValueOnce(
      new UserOpError("missing_role", `Smart account ${SAFE} is missing MINTER_ROLE`),
    );
    expect(await mintDirect(ctx, mintInput, mintAudit)).toEqual({
      error: `tokenOps.errors.minterRoleMissing ${JSON.stringify({
        safe: SAFE,
        token: "0x3333333333333333333333333333333333333333",
      })}`,
    });
    expect(prisma.tokenOperation.update).toHaveBeenLastCalledWith({
      where: { id: "op-1" },
      data: {
        status: "FAILED",
        errorMessage: `missing_role: Smart account ${SAFE} is missing MINTER_ROLE`,
      },
    });
  });

  it("confirms and records the role verification on a successful receipt", async () => {
    expect(await mintDirect(ctx, mintInput, mintAudit)).toEqual({
      ok: true,
      txHash: TX,
      userOpHash: "0xuserop",
    });
    expect(prisma.tokenOperation.update).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: { status: "CONFIRMED", txHash: TX, confirmedAt: expect.any(Date) },
    });
    expect(prisma.fund.update).toHaveBeenCalledWith({
      where: { id: "fund-1" },
      data: { tokenMintEnabledAt: expect.any(Date) },
    });
  });
});
