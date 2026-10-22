// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The burn path's "did this failure happen before the userop reached the
// bundler?" tag (failedBeforeSubmit) decides whether a payout's burn claim may
// be released, so it's tested against the real pipeline with only the network
// faked: every bundler / chain call goes through the stubbed `fetch` below.
vi.mock("server-only", () => ({}));
vi.mock("@/services/crypto/secret", () => ({
  // Any valid secp256k1 key — signing is real, nothing is ever sent anywhere.
  decryptSecret: () => `0x${"11".repeat(32)}`,
}));

import {
  attemptedUserOpHash,
  burnFromToken,
  failedBeforeSubmit,
  getTxReceiptWithLogs,
  mintToken,
  UserOpError,
} from "./userop";

const BUNDLER = "https://bundler.test";
const ZERO_WORD = `0x${"00".repeat(32)}`;

const fund = {
  id: "fund-1",
  tokenAddress: "0x3333333333333333333333333333333333333333",
  tokenChainId: 100,
  tokenMinterPrivateKeyEnc: "v1:enc",
  tokenMinterEoaAddress: "0x4444444444444444444444444444444444444444",
  tokenMinterSmartAccountAddress: "0x5555555555555555555555555555555555555555",
  citizenPayEntrypointAddress: "0x6666666666666666666666666666666666666666",
  citizenPayAccountFactoryAddress: "0x7777777777777777777777777777777777777777",
  citizenPayPaymasterAddress: "0x8888888888888888888888888888888888888888",
  citizenPayPaymasterType: "cw-safe",
  // Role verified: the mint path skips its pre-submit hasRole read (the
  // faked eth_call answers a zero word, which would read as "missing").
  tokenMintEnabledAt: new Date("2026-01-01T00:00:00Z"),
};

const args = {
  fund,
  from: "0x9999999999999999999999999999999999999999" as const,
  amount: BigInt(100),
};

type Rpc = { id: number; method: string; params: unknown[] };
type Reply = { status?: number; result?: unknown; error?: string };

// Per-method behaviour for the bundler JSON-RPC; `eth_call` (getUserOpHash,
// role reads) always answers a zero word, so `hasRole` reads as false.
let replies: Record<string, (rpc: Rpc) => Reply>;

function rpcResponse(rpc: Rpc, reply: Reply): Response {
  if (reply.status && reply.status >= 400) {
    return new Response("upstream error", { status: reply.status });
  }
  const body = reply.error
    ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: reply.error } }
    : { jsonrpc: "2.0", id: rpc.id, result: reply.result };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("CITIZENPAY_BUNDLER_URL", BUNDLER);
  replies = {
    eth_call: () => ({ result: ZERO_WORD }),
    pm_ooSponsorUserOperation: (rpc) => ({ result: [rpc.params[0]] }),
    eth_sendUserOperation: () => ({ result: `0x${"aa".repeat(32)}` }),
    pm_getUserOpTxHash: () => ({
      result: { user_op_hash: "0xaa", tx_hash: `0x${"bb".repeat(32)}`, status: "success" },
    }),
    // The bundler's `success` is re-checked against the real receipt.
    eth_getTransactionReceipt: () => ({
      result: { transactionHash: `0x${"bb".repeat(32)}`, status: "0x1", logs: [] },
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/exists")) return new Response("", { status: 200 });
      const rpc = JSON.parse(String(init?.body)) as Rpc;
      const handler = replies[rpc.method];
      if (!handler) throw new Error(`unexpected rpc ${rpc.method}`);
      return rpcResponse(rpc, handler(rpc));
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function burnError(): Promise<unknown> {
  try {
    await burnFromToken(args);
  } catch (e) {
    return e;
  }
  throw new Error("expected burnFromToken to throw");
}

describe("burnFromToken — failedBeforeSubmit", () => {
  it("succeeds end to end with the faked bundler", async () => {
    await expect(burnFromToken(args)).resolves.toEqual({
      txHash: `0x${"bb".repeat(32)}`,
      userOpHash: `0x${"aa".repeat(32)}`,
    });
  });

  it("tags a missing minter (config) as before submit", async () => {
    const e = await burnFromToken({
      ...args,
      fund: { ...fund, tokenMinterPrivateKeyEnc: null },
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(UserOpError);
    expect((e as UserOpError).code).toBe("fund_not_provisioned");
    expect(failedBeforeSubmit(e)).toBe(true);
  });

  it("tags a sponsor refusal as before submit", async () => {
    replies.pm_ooSponsorUserOperation = () => ({ error: "paymaster says no" });
    const e = await burnError();
    expect((e as UserOpError).code).toBe("sponsor_failed");
    expect(failedBeforeSubmit(e)).toBe(true);
    // Nothing was sent, so there's no attempt to look up.
    expect(attemptedUserOpHash(e)).toBeNull();
  });

  // A sponsor HTTP error is coded `submit_failed`, which triggers the role
  // diagnosis; the role error that replaces it must keep the tag.
  it("keeps the tag through the role diagnosis after a sponsor HTTP error", async () => {
    replies.pm_ooSponsorUserOperation = () => ({ status: 502 });
    const e = await burnError();
    expect((e as UserOpError).code).toBe("missing_role");
    expect(failedBeforeSubmit(e)).toBe(true);
  });

  it("does NOT tag a failed eth_sendUserOperation (may have been accepted)", async () => {
    replies.eth_sendUserOperation = () => ({ error: "bundler busy" });
    const e = await burnError();
    // Replaced by the role diagnosis, still untagged — and still carrying the
    // signed userop's hash so the attempt can be looked up.
    expect((e as UserOpError).code).toBe("missing_role");
    expect(failedBeforeSubmit(e)).toBe(false);
    expect(attemptedUserOpHash(e)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("does NOT tag a failure after submit (reverted userop)", async () => {
    replies.pm_getUserOpTxHash = () => ({
      result: { user_op_hash: "0xaa", tx_hash: "0xcc", status: "reverted" },
    });
    const e = await burnError();
    expect((e as UserOpError).code).toBe("tx_failed");
    expect(failedBeforeSubmit(e)).toBe(false);
    expect(attemptedUserOpHash(e)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("treats anything it never saw as possibly submitted", () => {
    expect(failedBeforeSubmit(new Error("x"))).toBe(false);
    expect(failedBeforeSubmit("boom")).toBe(false);
    expect(failedBeforeSubmit(null)).toBe(false);
  });
});

// The bundler reports `success` for any bundle that has a receipt — including
// one whose inner call reverted (the Demo fund's "Must have minter role to
// mint" mint, 2026-10-21). The settlement must be read from the receipt.
describe("mintToken — receipt status", () => {
  const mintArgs = {
    fund,
    to: "0x9999999999999999999999999999999999999999" as const,
    amount: BigInt(100),
  };
  const TX = `0x${"bb".repeat(32)}`;

  function sentUserOps(): number {
    const calls = vi.mocked(fetch).mock.calls as unknown as [
      unknown,
      RequestInit?,
    ][];
    return calls.filter(([, init]) =>
      String(init?.body ?? "").includes('"eth_sendUserOperation"'),
    ).length;
  }

  it("confirms on a receipt with status 0x1", async () => {
    await expect(mintToken(mintArgs)).resolves.toEqual({
      txHash: TX,
      userOpHash: `0x${"aa".repeat(32)}`,
    });
  });

  it("fails with tx_failed (keeping the tx hash) when the receipt says 0x0", async () => {
    replies.eth_getTransactionReceipt = () => ({
      result: { transactionHash: TX, status: "0x0", logs: [] },
    });
    const e = await mintToken(mintArgs).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(UserOpError);
    expect((e as UserOpError).code).toBe("tx_failed");
    expect((e as UserOpError).message).toMatch(/reverted on chain/);
    expect((e as UserOpError).txHash).toBe(TX);
    // It did reach the chain: not before-submit, and the attempt is known.
    expect(failedBeforeSubmit(e)).toBe(false);
    expect(attemptedUserOpHash(e)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses before submit when MINTER_ROLE was never verified and is missing", async () => {
    // eth_call answers a zero word → hasRole(MINTER_ROLE, safe) is false.
    const e = await mintToken({
      ...mintArgs,
      fund: { ...fund, tokenMintEnabledAt: null },
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(UserOpError);
    expect((e as UserOpError).code).toBe("missing_role");
    expect((e as UserOpError).message).toContain(fund.tokenMinterSmartAccountAddress);
    expect(failedBeforeSubmit(e)).toBe(true);
    expect(sentUserOps()).toBe(0);
  });

  it("submits when MINTER_ROLE was never verified but is held", async () => {
    replies.eth_call = () => ({ result: `0x${"00".repeat(31)}01` });
    await expect(
      mintToken({ ...mintArgs, fund: { ...fund, tokenMintEnabledAt: null } }),
    ).resolves.toMatchObject({ txHash: TX });
    expect(sentUserOps()).toBe(1);
  });
});

describe("getTxReceiptWithLogs", () => {
  it("returns status and logs, null for an unknown hash", async () => {
    replies.eth_getTransactionReceipt = (rpc) =>
      rpc.params[0] === "0xknown"
        ? {
            result: {
              transactionHash: "0xknown",
              status: "0x1",
              logs: [{ address: "0xt", topics: ["0xa"], data: "0x01" }],
            },
          }
        : { result: null };
    expect(await getTxReceiptWithLogs({ chainId: 100, txHash: "0xknown" })).toEqual({
      transactionHash: "0xknown",
      status: "success",
      logs: [{ address: "0xt", topics: ["0xa"], data: "0x01" }],
    });
    expect(await getTxReceiptWithLogs({ chainId: 100, txHash: "0xother" })).toBeNull();
  });

  it("throws when the node can't be reached", async () => {
    replies.eth_getTransactionReceipt = () => ({ status: 503 });
    await expect(
      getTxReceiptWithLogs({ chainId: 100, txHash: "0xknown" }),
    ).rejects.toThrow();
  });
});
