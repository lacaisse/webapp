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

import { burnFromToken, failedBeforeSubmit, UserOpError } from "./userop";

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
    // Replaced by the role diagnosis, still untagged.
    expect((e as UserOpError).code).toBe("missing_role");
    expect(failedBeforeSubmit(e)).toBe(false);
  });

  it("does NOT tag a failure after submit (reverted userop)", async () => {
    replies.pm_getUserOpTxHash = () => ({
      result: { user_op_hash: "0xaa", tx_hash: "0xcc", status: "reverted" },
    });
    const e = await burnError();
    expect((e as UserOpError).code).toBe("tx_failed");
    expect(failedBeforeSubmit(e)).toBe(false);
  });

  it("treats anything it never saw as possibly submitted", () => {
    expect(failedBeforeSubmit(new Error("x"))).toBe(false);
    expect(failedBeforeSubmit("boom")).toBe(false);
    expect(failedBeforeSubmit(null)).toBe(false);
  });
});
