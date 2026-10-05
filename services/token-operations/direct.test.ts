// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// burnDirect's `broadcast` flag: whether a failed burn may be on chain. The
// userop pipeline and the database are faked; userop.test.ts covers where the
// "failed before submit" tag itself comes from.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const prisma = vi.hoisted(() => ({
  tokenOperation: { create: vi.fn(), update: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const userop = vi.hoisted(() => ({
  burnFromToken: vi.fn(),
  mintToken: vi.fn(),
  failedBeforeSubmit: vi.fn(),
  attemptedUserOpHash: vi.fn(),
}));
vi.mock("@/services/token/userop", () => ({
  ...userop,
  UserOpError: class UserOpError extends Error {},
}));

const resolveOrEnqueueAnnotation = vi.hoisted(() => vi.fn());
vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation,
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({
  ANNOTATION_TRIGGERS: { adminDirectBurn: "ADMIN_DIRECT_BURN" },
}));

import { burnDirect, type DirectOpContext } from "./direct";

const TX = `0x${"ab".repeat(32)}`;
const ctx = {
  fund: { id: "fund-1", tokenAddress: "0x3333333333333333333333333333333333333333", tokenDecimals: 6, tokenChainId: 100 },
  userId: "user-1",
  t: (key: string) => key,
} as unknown as DirectOpContext;
const input = { from: "0x9999999999999999999999999999999999999999", amount: "12.50" };
const audit = { trigger: "PAYOUT_BURN" };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tokenOperation.create.mockResolvedValue({ id: "op-1" });
  prisma.tokenOperation.update.mockResolvedValue({});
  userop.burnFromToken.mockResolvedValue({ txHash: TX, userOpHash: "0xuserop" });
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
});
