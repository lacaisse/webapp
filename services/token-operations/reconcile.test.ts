// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileOperation } from "./reconcile";

const getUserOpTx = vi.hoisted(() => vi.fn());
vi.mock("@/services/token/userop", () => ({ getUserOpTx }));

describe("reconcileOperation", () => {
  beforeEach(() => getUserOpTx.mockReset());

  it("reports never-submitted when the op has no hash, without calling the bundler", async () => {
    expect(await reconcileOperation({ chainId: 100, txHash: null })).toEqual({
      kind: "never-submitted",
    });
    expect(getUserOpTx).not.toHaveBeenCalled();
  });

  it("returns the settlement tx hash when the userOp succeeded", async () => {
    getUserOpTx.mockResolvedValue({ status: "success", txHash: "0xsettled" });
    expect(await reconcileOperation({ chainId: 100, txHash: "0xuserop" })).toEqual({
      kind: "settled",
      txHash: "0xsettled",
    });
  });

  // The whole point of manual reconcile: not-yet-settled is not failure. A
  // UserOp can outlive the submit path's poll window and still land.
  it.each(["pending", "submitted"] as const)("treats %s as still in flight", async (status) => {
    getUserOpTx.mockResolvedValue({ status, txHash: null });
    expect(await reconcileOperation({ chainId: 100, txHash: "0xuserop" })).toEqual({
      kind: "pending",
      status,
    });
  });

  it.each(["reverted", "timeout"] as const)("treats %s as terminal failure", async (status) => {
    getUserOpTx.mockResolvedValue({ status, txHash: "0xdead" });
    expect(await reconcileOperation({ chainId: 100, txHash: "0xuserop" })).toEqual({
      kind: "failed",
      status,
      txHash: "0xdead",
    });
  });

  // A flaky bundler must never look like an on-chain failure — otherwise an
  // admin could mark a settled allocation failed and mint it a second time.
  it("reports unknown when the bundler throws", async () => {
    // `...Once` on purpose: a mock that throws (or whose rejection is left
    // queued for later calls) is reported as a test failure by vitest even
    // when reconcileOperation catches it, because the stored mock result is
    // still an un-awaited rejection.
    getUserOpTx.mockRejectedValueOnce(new Error("ECONNRESET"));
    const out = await reconcileOperation({ chainId: 100, txHash: "0xuserop" });
    expect(out.kind).toBe("unknown");
  });

  it("reports unknown when the bundler claims success with no tx hash", async () => {
    getUserOpTx.mockResolvedValue({ status: "success", txHash: null });
    expect((await reconcileOperation({ chainId: 100, txHash: "0xuserop" })).kind).toBe(
      "unknown",
    );
  });
});
