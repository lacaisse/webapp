// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const findFirst = vi.hoisted(() => vi.fn());
vi.mock("@/services/db/prisma", () => ({ prisma: { tokenOperation: { findFirst } } }));
const getUserOpTx = vi.hoisted(() => vi.fn());
vi.mock("@/services/token/userop", () => ({ getUserOpTx }));

import { findBurnAttempt } from "./burn-attempt";

const USEROP = `0x${"cd".repeat(32)}`;
const args = {
  fundId: "f1",
  chainId: 100,
  placeAccount: "0xPlace",
  net: "48.75",
  claimedAt: "2026-10-05T09:30:00Z",
};
const row = (over: Record<string, unknown>) => ({
  status: "FAILED",
  txHash: null,
  errorMessage: null,
  createdAt: new Date("2026-10-05T09:30:01Z"),
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("findBurnAttempt", () => {
  it("matches this payout's burn: fund, place account, net, after the claim", async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(await findBurnAttempt(args)).toEqual({ kind: "none" });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          fundId: "f1",
          type: "BURN",
          account: { equals: "0xPlace", mode: "insensitive" },
          amount: "48.75",
          createdAt: { gte: new Date(args.claimedAt) },
        },
      }),
    );
  });

  it("reports a still-PENDING row as running", async () => {
    findFirst.mockResolvedValueOnce(row({ status: "PENDING" }));
    expect(await findBurnAttempt(args)).toEqual({
      kind: "running",
      startedAt: "2026-10-05T09:30:01.000Z",
    });
  });

  it("reports a failure without a userOp as not sent", async () => {
    findFirst.mockResolvedValueOnce(row({ errorMessage: "sponsor_failed: no" }));
    expect(await findBurnAttempt(args)).toEqual({ kind: "notSent" });
  });

  it("looks up the stored userOp on the bundler", async () => {
    findFirst.mockResolvedValueOnce(
      row({ errorMessage: `tx_failed: timeout [userOp ${USEROP}]` }),
    );
    getUserOpTx.mockResolvedValueOnce({ status: "success", txHash: "0xtx" });
    expect(await findBurnAttempt(args)).toEqual({
      kind: "sent",
      userOpHash: USEROP,
      txHash: "0xtx",
      status: "success",
    });
    expect(getUserOpTx).toHaveBeenCalledWith(100, USEROP);
  });

  it("degrades to unknown when the bundler can't be read", async () => {
    findFirst.mockResolvedValueOnce(row({ errorMessage: `x [userOp ${USEROP}]` }));
    getUserOpTx.mockRejectedValueOnce(new Error("down"));
    expect(await findBurnAttempt(args)).toMatchObject({ kind: "sent", status: "unknown" });
  });
});
