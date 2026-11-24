// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  queueConfirmTransaction,
  queueGetMultisigTransaction,
  queueListPendingTransactions,
  queueProposeTransaction,
} from "@/services/safe/queue-service";
import { buildSafeTx } from "@/services/safe/safe-tx";
import { SafeError, type Address, type Hex } from "@/services/safe/types";

// Wire shapes follow the Queue Service OpenAPI schema (v0.10.1): lowercase
// addresses, decimal-string numbers, null for the zero address.
const BASE = "https://api.safe.global/queue";
const SAFE = "0x8ad5a865cc1942b1b2b36c186403f89bff512aa0" as Address;
const SAFE_CS = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0";
const OTHER_SAFE = "0x5afe00000000000000000000000000000000cafe";
const OWNER = "0x964ae5ab627f1d536d5d5796734b7a44ad6531e3" as Address;
const OWNER_CS = "0x964aE5aB627f1d536d5d5796734B7a44AD6531E3";
const ZERO = "0x0000000000000000000000000000000000000000";
const HASH = `0x${"ab".repeat(32)}` as Hex;
const TX_HASH = `0x${"ef".repeat(32)}`;
const SIG = `0x${"cd".repeat(64)}1b` as Hex;

function apiTx(nonce: number, over: Record<string, unknown> = {}) {
  return {
    safeTxHash: `0x${nonce.toString(16).padStart(64, "0")}`,
    chainId: "100",
    safe: SAFE,
    nonce: String(nonce),
    proposer: OWNER,
    proposedVia: "OWNER",
    proposedBy: null,
    to: OWNER,
    value: "0",
    data: null,
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: null,
    refundReceiver: null,
    failed: null,
    notes: null,
    originName: "La Caisse",
    originUrl: null,
    txHash: null,
    executor: null,
    created: "2026-11-24T10:00:00Z",
    modified: "2026-11-24T10:05:00Z",
    confirmations: [
      {
        owner: OWNER,
        signature: SIG,
        signatureType: "EOA",
        created: "2026-11-24T10:00:00Z",
        modified: "2026-11-24T10:00:00Z",
      },
    ],
    ...over,
  };
}

type Call = { url: string; init: RequestInit };
let calls: Call[];

function stubFetch(responder: (url: string, init: RequestInit) => Response) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responder(url, init);
    }),
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(c: Call): unknown {
  return JSON.parse(c.init.body as string);
}

beforeEach(() => {
  vi.stubEnv("SAFE_API_KEY", "");
  vi.stubEnv("APP_DOMAIN", "localhost");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("queueGetMultisigTransaction", () => {
  it("reads the transaction by hash and normalises it", async () => {
    stubFetch(() => json(200, apiTx(5, { data: "0x1234", to: null })));
    const tx = await queueGetMultisigTransaction(BASE, { chainId: 100, safeTxHash: HASH });
    expect(calls[0].url).toBe(`${BASE}/api/v1/multisig-transactions/${HASH}`);
    expect(calls[0].init.method).toBe("GET");
    expect(tx).toEqual({
      safe: SAFE_CS,
      safeTxHash: `0x${"5".padStart(64, "0")}`,
      nonce: 5,
      to: ZERO,
      value: "0",
      data: "0x1234",
      operation: 0,
      isExecuted: false,
      isSuccessful: null,
      transactionHash: null,
      executionDate: null,
      submissionDate: "2026-11-24T10:00:00Z",
      confirmations: [
        { owner: OWNER_CS, signature: SIG, signatureType: "EOA", submissionDate: "2026-11-24T10:00:00Z" },
      ],
      confirmationsRequired: null,
      proposer: OWNER_CS,
    });
  });

  it("derives executed / successful from txHash and failed", async () => {
    stubFetch(() => json(200, apiTx(5, { txHash: TX_HASH, failed: false })));
    await expect(
      queueGetMultisigTransaction(BASE, { chainId: 100, safeTxHash: HASH }),
    ).resolves.toMatchObject({ isExecuted: true, isSuccessful: true, transactionHash: TX_HASH });
    stubFetch(() => json(200, apiTx(5, { txHash: TX_HASH, failed: true })));
    await expect(
      queueGetMultisigTransaction(BASE, { chainId: 100, safeTxHash: HASH }),
    ).resolves.toMatchObject({ isExecuted: true, isSuccessful: false });
  });

  it("sends the API key and the apex Referer like the Transaction Service client", async () => {
    vi.stubEnv("SAFE_API_KEY", "test-key");
    vi.stubEnv("APP_DOMAIN", "lacaisse.eu");
    stubFetch(() => json(404, { detail: "Not found" }));
    await queueGetMultisigTransaction(BASE, { chainId: 100, safeTxHash: HASH });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers.referer).toBe("https://lacaisse.eu/");
  });

  it("returns null on 404, and for a transaction of another chain", async () => {
    stubFetch(() => json(404, { detail: "Not found" }));
    await expect(
      queueGetMultisigTransaction(BASE, { chainId: 100, safeTxHash: HASH }),
    ).resolves.toBeNull();
    stubFetch(() => json(200, apiTx(5, { chainId: "1" })));
    await expect(
      queueGetMultisigTransaction(BASE, { chainId: 100, safeTxHash: HASH }),
    ).resolves.toBeNull();
  });

  it("throws tx_service on a shape mismatch", async () => {
    stubFetch(() => json(200, apiTx(5, { nonce: "x" })));
    await expect(
      queueGetMultisigTransaction(BASE, { chainId: 100, safeTxHash: HASH }),
    ).rejects.toMatchObject({ code: "tx_service" });
  });
});

describe("queueListPendingTransactions", () => {
  it("asks /queue for the Safe on its chain, with the schema's parameter names only", async () => {
    stubFetch(() =>
      json(200, { count: 2, next: null, previous: null, results: [apiTx(3), apiTx(4)] }),
    );
    const txs = await queueListPendingTransactions(BASE, { chainId: 100, safeAddress: SAFE });
    expect(txs.map((t) => t.nonce)).toEqual([3, 4]);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/queue/api/v1/multisig-transactions/queue");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      safes: `${SAFE_CS}:100`,
      nonceOrder: "asc",
      limit: "100",
      offset: "0",
    });
  });

  it("follows offsets until the last page, capped at 5 pages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => apiTx(i));
    stubFetch(() => json(200, { count: 1000, next: "x", previous: null, results: full }));
    const txs = await queueListPendingTransactions(BASE, { chainId: 100, safeAddress: SAFE });
    expect(calls).toHaveLength(5);
    expect(txs).toHaveLength(500);
    expect(new URL(calls[4].url).searchParams.get("offset")).toBe("400");
  });

  it("stops when count is reached", async () => {
    const full = Array.from({ length: 100 }, (_, i) => apiTx(i));
    stubFetch(() => json(200, { count: 100, next: null, previous: null, results: full }));
    await queueListPendingTransactions(BASE, { chainId: 100, safeAddress: SAFE });
    expect(calls).toHaveLength(1);
  });

  it("drops results of another Safe or another chain", async () => {
    stubFetch(() =>
      json(200, {
        count: 3,
        next: null,
        previous: null,
        results: [apiTx(1), apiTx(2, { safe: OTHER_SAFE }), apiTx(3, { chainId: "1" })],
      }),
    );
    const txs = await queueListPendingTransactions(BASE, { chainId: 100, safeAddress: SAFE });
    expect(txs.map((t) => t.nonce)).toEqual([1]);
  });

  it("throws tx_service when the service does not know the Safe (422) or the chain (503)", async () => {
    stubFetch(() => json(422, { detail: "Safe not found" }));
    await expect(
      queueListPendingTransactions(BASE, { chainId: 100, safeAddress: SAFE }),
    ).rejects.toMatchObject({ code: "tx_service" });
    stubFetch(() => json(503, { detail: "Safe info unavailable" }));
    await expect(
      queueListPendingTransactions(BASE, { chainId: 100, safeAddress: SAFE }),
    ).rejects.toMatchObject({ code: "tx_service" });
  });

  it("rejects a malformed envelope", async () => {
    stubFetch(() => json(200, { count: 1, results: "nope" }));
    await expect(
      queueListPendingTransactions(BASE, { chainId: 100, safeAddress: SAFE }),
    ).rejects.toMatchObject({ code: "tx_service" });
  });
});

describe("queueProposeTransaction", () => {
  const tx = buildSafeTx({ to: OWNER, value: BigInt(5), nonce: BigInt(9) });
  const args = {
    chainId: 100,
    safeAddress: SAFE,
    tx,
    safeTxHash: HASH,
    sender: OWNER,
    signature: SIG,
  };

  it("POSTs the proposal with the Safe and the chain in the body", async () => {
    vi.stubEnv("APP_DOMAIN", "lacaisse.eu");
    stubFetch(() => json(201, apiTx(9)));
    await queueProposeTransaction(BASE, args);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/v1/multisig-transactions`);
    expect(calls[0].init.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({
      chainId: 100,
      safe: SAFE_CS,
      to: OWNER_CS,
      value: "5",
      data: null,
      operation: 0,
      gasToken: ZERO,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      refundReceiver: ZERO,
      nonce: "9",
      signatures: [SIG],
      originName: "La Caisse",
      originUrl: "https://lacaisse.eu",
    });
  });

  it("sends no origin URL from localhost", async () => {
    stubFetch(() => json(201, apiTx(9)));
    await queueProposeTransaction(BASE, args);
    expect(bodyOf(calls[0])).toMatchObject({ originName: "La Caisse", originUrl: null });
  });

  it("on 409 (hash already stored) sends the signature on its own", async () => {
    stubFetch((url) =>
      url.endsWith("/signatures")
        ? json(201, [])
        : json(409, { detail: "Transaction already exists" }),
    );
    await expect(queueProposeTransaction(BASE, args)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`${BASE}/api/v1/multisig-transactions/${HASH}/signatures`);
    expect(bodyOf(calls[1])).toEqual({ signatures: [SIG] });
  });

  it("on 409 twice (proposal and signature both there) succeeds", async () => {
    stubFetch(() => json(409, { detail: "already" }));
    await expect(queueProposeTransaction(BASE, args)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("throws on 422 (signer not an owner, nonce below the Safe's) and 503", async () => {
    stubFetch(() => json(422, { detail: "Signer is not an owner" }));
    await expect(queueProposeTransaction(BASE, args)).rejects.toMatchObject({ code: "tx_service" });
    stubFetch(() =>
      json(422, { detail: [{ loc: ["body", "nonce"], msg: "bad", type: "value_error" }] }),
    );
    await expect(queueProposeTransaction(BASE, args)).rejects.toMatchObject({ code: "tx_service" });
    stubFetch(() => json(503, { detail: "Safe info unavailable" }));
    try {
      await queueProposeTransaction(BASE, args);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SafeError);
      expect((e as SafeError).message).toContain("HTTP 503");
    }
  });

  it("throws when the signature that follows a 409 is refused (executed transaction)", async () => {
    stubFetch((url) =>
      url.endsWith("/signatures")
        ? json(422, { detail: "Transaction is already executed" })
        : json(409, { detail: "Transaction already exists" }),
    );
    await expect(queueProposeTransaction(BASE, args)).rejects.toMatchObject({ code: "tx_service" });
  });
});

describe("queueConfirmTransaction", () => {
  const args = { chainId: 100, safeTxHash: HASH, signature: SIG };

  it("POSTs the signature as an array to the signatures endpoint", async () => {
    stubFetch(() => json(201, []));
    await queueConfirmTransaction(BASE, args);
    expect(calls[0].url).toBe(`${BASE}/api/v1/multisig-transactions/${HASH}/signatures`);
    expect(bodyOf(calls[0])).toEqual({ signatures: [SIG] });
  });

  it("tolerates 409 (owner already confirmed)", async () => {
    stubFetch(() => json(409, { detail: "Owner already confirmed" }));
    await expect(queueConfirmTransaction(BASE, args)).resolves.toBeUndefined();
  });

  it("throws on 404, 422 and 5xx", async () => {
    for (const status of [404, 422, 500]) {
      stubFetch(() => json(status, { detail: "no" }));
      await expect(queueConfirmTransaction(BASE, args)).rejects.toMatchObject({
        code: "tx_service",
      });
    }
  });
});
