// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildSafeTx } from "@/services/safe/safe-tx";
import {
  confirmTransaction,
  getMultisigTransaction,
  getSafeInfo,
  isTxServiceEnabled,
  listPendingTransactions,
  proposeTransaction,
} from "@/services/safe/tx-service";
import { SafeError, type Address, type Hex } from "@/services/safe/types";

const BASE = "https://api.safe.global/tx-service/gno/api";
const SAFE = "0x8ad5a865cc1942b1b2b36c186403f89bff512aa0" as Address;
const SAFE_CS = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0";
const OWNER = "0x964ae5ab627f1d536d5d5796734b7a44ad6531e3" as Address;
const OWNER_CS = "0x964aE5aB627f1d536d5d5796734B7a44AD6531E3";
const HASH = `0x${"ab".repeat(32)}` as Hex;
const SIG = `0x${"cd".repeat(64)}1b` as Hex;

function apiTx(nonce: number, over: Record<string, unknown> = {}) {
  return {
    safe: SAFE,
    to: OWNER,
    value: "0",
    data: null,
    operation: 0,
    gasToken: "0x0000000000000000000000000000000000000000",
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: String(nonce),
    executionDate: null,
    submissionDate: "2026-10-29T10:00:00Z",
    modified: "2026-10-29T10:00:00Z",
    blockNumber: null,
    transactionHash: null,
    safeTxHash: `0x${nonce.toString(16).padStart(64, "0")}`,
    proposer: OWNER,
    isExecuted: false,
    isSuccessful: null,
    confirmationsRequired: 2,
    confirmations: [
      {
        owner: OWNER,
        submissionDate: "2026-10-29T10:00:00Z",
        transactionHash: null,
        signature: SIG,
        signatureType: "EOA",
      },
    ],
    trusted: true,
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

function headersOf(c: Call): Record<string, string> {
  return c.init.headers as Record<string, string>;
}

beforeEach(() => {
  vi.stubEnv("SAFE_TX_SERVICE_URL", "");
  vi.stubEnv("SAFE_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("isTxServiceEnabled", () => {
  it("is on for Gnosis, off for unknown chains", () => {
    expect(isTxServiceEnabled(100)).toBe(true);
    expect(isTxServiceEnabled(31337)).toBe(false);
  });

  it("honours SAFE_TX_SERVICE_URL (trailing slash trimmed)", async () => {
    vi.stubEnv("SAFE_TX_SERVICE_URL", "http://localhost:8000/api/");
    stubFetch(() => new Response("", { status: 404 }));
    await getSafeInfo({ chainId: 100, safeAddress: SAFE });
    expect(calls[0].url).toBe(`http://localhost:8000/api/v1/safes/${SAFE_CS}/`);
  });
});

describe("getSafeInfo", () => {
  it("parses the v1 safe info and checksums addresses", async () => {
    stubFetch(() =>
      json(200, {
        address: SAFE,
        nonce: "12",
        threshold: 2,
        owners: [OWNER],
        masterCopy: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
        modules: [],
        fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
        guard: "0x0000000000000000000000000000000000000000",
        moduleGuard: "0x0000000000000000000000000000000000000000",
        version: "1.4.1+L2",
      }),
    );
    await expect(getSafeInfo({ chainId: 100, safeAddress: SAFE })).resolves.toEqual({
      address: SAFE_CS,
      nonce: 12,
      threshold: 2,
      owners: [OWNER_CS],
      version: "1.4.1+L2",
    });
    expect(calls[0].url).toBe(`${BASE}/v1/safes/${SAFE_CS}/`);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.cache).toBe("no-store");
  });

  it("returns null on 404", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    await expect(getSafeInfo({ chainId: 100, safeAddress: SAFE })).resolves.toBeNull();
  });

  it("throws tx_service on a shape mismatch", async () => {
    stubFetch(() => json(200, { address: SAFE, nonce: "x", threshold: 2, owners: [] }));
    await expect(getSafeInfo({ chainId: 100, safeAddress: SAFE })).rejects.toMatchObject({
      code: "tx_service",
    });
  });
});

describe("auth header", () => {
  it("is absent without SAFE_API_KEY", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    await getMultisigTransaction({ chainId: 100, safeTxHash: HASH });
    expect(headersOf(calls[0]).authorization).toBeUndefined();
  });

  it("is a Bearer token with SAFE_API_KEY", async () => {
    vi.stubEnv("SAFE_API_KEY", "test-key");
    stubFetch(() => new Response("", { status: 404 }));
    await getMultisigTransaction({ chainId: 100, safeTxHash: HASH });
    expect(headersOf(calls[0]).authorization).toBe("Bearer test-key");
  });
});

describe("getMultisigTransaction", () => {
  it("reads the v2 endpoint and normalises the tx", async () => {
    stubFetch(() => json(200, apiTx(5, { data: "0x1234", isExecuted: true, isSuccessful: true })));
    const tx = await getMultisigTransaction({ chainId: 100, safeTxHash: HASH });
    expect(calls[0].url).toBe(`${BASE}/v2/multisig-transactions/${HASH}/`);
    expect(tx).toMatchObject({
      safe: SAFE_CS,
      to: OWNER_CS,
      nonce: 5,
      value: "0",
      data: "0x1234",
      isExecuted: true,
      isSuccessful: true,
      confirmationsRequired: 2,
      proposer: OWNER_CS,
      confirmations: [{ owner: OWNER_CS, signature: SIG, signatureType: "EOA" }],
    });
  });

  it("returns null on 404", async () => {
    stubFetch(() => json(404, { detail: "No MultisigTransaction matches the given query." }));
    await expect(getMultisigTransaction({ chainId: 100, safeTxHash: HASH })).resolves.toBeNull();
  });

  it("throws tx_service with status and body on other errors", async () => {
    stubFetch(() => new Response("upstream boom", { status: 502 }));
    try {
      await getMultisigTransaction({ chainId: 100, safeTxHash: HASH });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SafeError);
      expect((e as SafeError).code).toBe("tx_service");
      expect((e as SafeError).message).toContain("HTTP 502: upstream boom");
    }
  });
});

describe("listPendingTransactions", () => {
  it("parses the paginated envelope", async () => {
    stubFetch(() =>
      json(200, { count: 2, next: null, previous: null, results: [apiTx(3), apiTx(4)] }),
    );
    const txs = await listPendingTransactions({ chainId: 100, safeAddress: SAFE });
    expect(txs.map((t) => t.nonce)).toEqual([3, 4]);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/tx-service/gno/api/v2/safes/${SAFE_CS}/multisig-transactions/`);
    expect(url.searchParams.get("executed")).toBe("false");
    expect(url.searchParams.get("ordering")).toBe("nonce");
  });

  it("follows offsets until the last page, capped at 5 pages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => apiTx(i));
    stubFetch(() => json(200, { count: 1000, next: "x", previous: null, results: full }));
    const txs = await listPendingTransactions({ chainId: 100, safeAddress: SAFE });
    expect(calls).toHaveLength(5);
    expect(txs).toHaveLength(500);
    expect(new URL(calls[4].url).searchParams.get("offset")).toBe("400");
  });

  it("stops when count is reached", async () => {
    const full = Array.from({ length: 100 }, (_, i) => apiTx(i));
    stubFetch(() => json(200, { count: 100, next: null, previous: null, results: full }));
    await listPendingTransactions({ chainId: 100, safeAddress: SAFE });
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed envelope", async () => {
    stubFetch(() => json(200, { count: 1, results: "nope" }));
    await expect(
      listPendingTransactions({ chainId: 100, safeAddress: SAFE }),
    ).rejects.toMatchObject({ code: "tx_service" });
  });
});

describe("proposeTransaction", () => {
  const tx = buildSafeTx({ to: OWNER, value: BigInt(5), nonce: BigInt(9) });
  const args = {
    chainId: 100,
    safeAddress: SAFE,
    tx,
    safeTxHash: HASH,
    sender: OWNER,
    signature: SIG,
  };

  it("POSTs the v2 body", async () => {
    stubFetch(() => new Response("", { status: 201 }));
    await proposeTransaction(args);
    expect(calls[0].url).toBe(`${BASE}/v2/safes/${SAFE_CS}/multisig-transactions/`);
    expect(calls[0].init.method).toBe("POST");
    expect(headersOf(calls[0])["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      safe: SAFE_CS,
      to: OWNER_CS,
      value: "5",
      data: null,
      operation: 0,
      gasToken: "0x0000000000000000000000000000000000000000",
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: "9",
      contractTransactionHash: HASH,
      sender: OWNER_CS,
      signature: SIG,
      origin: "La Caisse",
    });
  });

  it("tolerates an already-exists 422", async () => {
    stubFetch(() => json(422, { code: 1, message: "Transaction already exists", arguments: [] }));
    await expect(proposeTransaction(args)).resolves.toBeUndefined();
  });

  it("does not tolerate other 4xx (e.g. sender not an owner, nonce executed)", async () => {
    stubFetch(() => json(422, { code: 2, message: "Sender is not an owner", arguments: [] }));
    await expect(proposeTransaction(args)).rejects.toMatchObject({ code: "tx_service" });
    stubFetch(() =>
      json(400, { nonFieldErrors: ["Tx with nonce 9 already executed, duplicate"] }),
    );
    await expect(proposeTransaction(args)).rejects.toMatchObject({ code: "tx_service" });
  });
});

describe("confirmTransaction", () => {
  it("POSTs the signature to the v1 confirmations endpoint", async () => {
    stubFetch(() => new Response("", { status: 201 }));
    await confirmTransaction({ chainId: 100, safeTxHash: HASH, signature: SIG });
    expect(calls[0].url).toBe(`${BASE}/v1/multisig-transactions/${HASH}/confirmations/`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ signature: SIG });
  });

  it("tolerates an already-confirmed answer", async () => {
    stubFetch(() => json(400, { signature: [`Signature for owner ${OWNER} already confirmed`] }));
    await expect(
      confirmTransaction({ chainId: 100, safeTxHash: HASH, signature: SIG }),
    ).resolves.toBeUndefined();
  });

  it("throws tx_service on 5xx", async () => {
    stubFetch(() => new Response("oops", { status: 500 }));
    await expect(
      confirmTransaction({ chainId: 100, safeTxHash: HASH, signature: SIG }),
    ).rejects.toMatchObject({ code: "tx_service" });
  });
});
