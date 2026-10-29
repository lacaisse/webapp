// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress, isAddress, isHex } from "viem";

import { txServiceBaseUrl } from "@/services/safe/config";
import { SafeError, type Address, type Hex, type SafeTx } from "@/services/safe/types";

// Safe Transaction Service HTTP client (no SDK). Proposals and confirmations
// made in La Caisse are mirrored here so external owners see and sign them in
// Safe{Wallet}; sync reads their signatures back. Module map:
// services/safe/config.ts.
//
// Paths verified against the hosted service's OpenAPI (GET
// https://api.safe.global/tx-service/gno/schema/, service v6.13.0, 2026-10-29):
//   GET  /v1/safes/{address}/                              SafeInfoResponse (nonce is a string)
//   GET  /v2/multisig-transactions/{safeTxHash}/           (v1 is deprecated)
//   GET  /v2/safes/{address}/multisig-transactions/        paginated { count, next, results }
//   POST /v2/safes/{address}/multisig-transactions/        201 "Created or signature updated"
//   POST /v1/multisig-transactions/{safeTxHash}/confirmations/   201
// The list endpoints return only `trusted` txs by default (proposed by an
// owner or delegate) — exactly the ones worth syncing; spam proposals by
// non-owners stay out.
//
// `SAFE_API_KEY` (optional) is sent as a Bearer token; without it the hosted
// service allows a low unauthenticated rate. 10 s timeout per request.

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export type TxServiceConfirmation = {
  owner: Address;
  signature: Hex | null;
  signatureType: string | null;
  submissionDate: string;
};

export type TxServiceMultisigTx = {
  safe: Address;
  safeTxHash: Hex;
  nonce: number;
  to: Address;
  value: string;
  data: Hex | null;
  operation: number;
  isExecuted: boolean;
  isSuccessful: boolean | null;
  transactionHash: Hex | null;
  executionDate: string | null;
  submissionDate: string;
  confirmations: TxServiceConfirmation[];
  confirmationsRequired: number | null;
  proposer: Address | null;
};

export type TxServiceSafeInfo = {
  address: Address;
  nonce: number;
  threshold: number;
  owners: Address[];
  version: string | null;
};

export function isTxServiceEnabled(chainId: number): boolean {
  return txServiceBaseUrl(chainId) !== null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type HttpResult = { status: number; text: string };

async function send(
  chainId: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const base = txServiceBaseUrl(chainId);
  if (!base) {
    throw new SafeError("unsupported_chain", `No Safe Transaction Service for chain ${chainId}`);
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const apiKey = process.env.SAFE_API_KEY?.trim();
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    // Safe API keys can be restricted to domains (the dashboard's allowed
    // hosts, e.g. `lacaisse.eu` / `*.lacaisse.eu`); the service enforces that
    // on the Referer host and answers 403 "Your referer host is not allowed"
    // to a server-side call, which carries none. Identify as the apex so a
    // domain-restricted key still works from the server.
    const apex = process.env.APP_DOMAIN?.trim();
    if (apex && apex !== "localhost") headers.referer = `https://${apex}/`;
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new SafeError("tx_service", `${method} ${path} failed: ${reason}`, { cause: e });
  }
  return { status: res.status, text: await res.text().catch(() => "") };
}

function httpError(method: string, path: string, r: HttpResult): SafeError {
  return new SafeError(
    "tx_service",
    `${method} ${path} HTTP ${r.status}: ${r.text.slice(0, 300)}`,
  );
}

function parseJson(method: string, path: string, r: HttpResult): unknown {
  try {
    return JSON.parse(r.text);
  } catch {
    throw new SafeError("tx_service", `${method} ${path}: response is not JSON`);
  }
}

/** GET returning parsed JSON, or null on 404. */
async function getJson(chainId: number, path: string): Promise<unknown | null> {
  const r = await send(chainId, "GET", path);
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw httpError("GET", path, r);
  return parseJson("GET", path, r);
}

// A re-submission the service already has: the proposal or confirmation is in
// place, which is all we wanted. An "already executed" answer is NOT benign
// (the nonce is spent) and still throws.
const ALREADY_THERE = /already (exists|confirmed|been confirmed)|duplicate/i;

async function postJson(chainId: number, path: string, body: unknown): Promise<void> {
  const r = await send(chainId, "POST", path, body);
  if (r.status >= 200 && r.status < 300) return;
  if ((r.status === 400 || r.status === 422) && ALREADY_THERE.test(r.text) && !/executed/i.test(r.text)) {
    return;
  }
  throw httpError("POST", path, r);
}

// ---------------------------------------------------------------------------
// Shape parsing
// ---------------------------------------------------------------------------

class ShapeError extends Error {}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ShapeError(`${what} is not an object`);
  }
  return v as Record<string, unknown>;
}

function addr(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) {
    throw new ShapeError(`${what} is not an address`);
  }
  return getAddress(v);
}

function addrOrNull(v: unknown, what: string): Address | null {
  return v === null || v === undefined || v === "" ? null : addr(v, what);
}

function hex(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !isHex(v)) throw new ShapeError(`${what} is not hex`);
  return v;
}

function hexOrNull(v: unknown, what: string): Hex | null {
  return v === null || v === undefined || v === "" ? null : hex(v, what);
}

function int(v: unknown, what: string): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new ShapeError(`${what} is not an integer`);
  }
  return n;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new ShapeError(`${what} is not a string`);
  return v;
}

function strOrNull(v: unknown, what: string): string | null {
  return v === null || v === undefined ? null : str(v, what);
}

function parseConfirmation(v: unknown): TxServiceConfirmation {
  const c = obj(v, "confirmation");
  return {
    owner: addr(c.owner, "confirmation.owner"),
    signature: hexOrNull(c.signature, "confirmation.signature"),
    signatureType: strOrNull(c.signatureType, "confirmation.signatureType"),
    submissionDate: str(c.submissionDate, "confirmation.submissionDate"),
  };
}

function parseMultisigTx(v: unknown): TxServiceMultisigTx {
  const t = obj(v, "multisig transaction");
  const confirmations = t.confirmations ?? [];
  if (!Array.isArray(confirmations)) throw new ShapeError("confirmations is not an array");
  const value = t.value;
  if (!(typeof value === "string" && /^\d+$/.test(value)) && typeof value !== "number") {
    throw new ShapeError("value is not an integer");
  }
  return {
    safe: addr(t.safe, "safe"),
    safeTxHash: hex(t.safeTxHash, "safeTxHash"),
    nonce: int(t.nonce, "nonce"),
    to: addr(t.to, "to"),
    value: String(value),
    data: hexOrNull(t.data, "data"),
    operation: int(t.operation, "operation"),
    isExecuted: t.isExecuted === true,
    isSuccessful: typeof t.isSuccessful === "boolean" ? t.isSuccessful : null,
    transactionHash: hexOrNull(t.transactionHash, "transactionHash"),
    executionDate: strOrNull(t.executionDate, "executionDate"),
    submissionDate: str(t.submissionDate, "submissionDate"),
    confirmations: confirmations.map(parseConfirmation),
    confirmationsRequired:
      t.confirmationsRequired === null || t.confirmationsRequired === undefined
        ? null
        : int(t.confirmationsRequired, "confirmationsRequired"),
    proposer: addrOrNull(t.proposer, "proposer"),
  };
}

function parseSafeInfo(v: unknown): TxServiceSafeInfo {
  const s = obj(v, "safe info");
  if (!Array.isArray(s.owners)) throw new ShapeError("owners is not an array");
  return {
    address: addr(s.address, "address"),
    nonce: int(s.nonce, "nonce"),
    threshold: int(s.threshold, "threshold"),
    owners: s.owners.map((o, i) => addr(o, `owners[${i}]`)),
    version: strOrNull(s.version, "version"),
  };
}

function shaped<T>(method: string, path: string, parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    if (e instanceof ShapeError) {
      throw new SafeError("tx_service", `${method} ${path}: unexpected response (${e.message})`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function getSafeInfo(a: {
  chainId: number;
  safeAddress: Address;
}): Promise<TxServiceSafeInfo | null> {
  const path = `/v1/safes/${getAddress(a.safeAddress)}/`;
  const json = await getJson(a.chainId, path);
  return json === null ? null : shaped("GET", path, () => parseSafeInfo(json));
}

export async function getMultisigTransaction(a: {
  chainId: number;
  safeTxHash: Hex;
}): Promise<TxServiceMultisigTx | null> {
  const path = `/v2/multisig-transactions/${a.safeTxHash}/`;
  const json = await getJson(a.chainId, path);
  return json === null ? null : shaped("GET", path, () => parseMultisigTx(json));
}

/** Not-yet-executed (trusted) txs for the Safe, nonce ascending, ≤ 500. */
export async function listPendingTransactions(a: {
  chainId: number;
  safeAddress: Address;
}): Promise<TxServiceMultisigTx[]> {
  const safe = getAddress(a.safeAddress);
  const out: TxServiceMultisigTx[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const path =
      `/v2/safes/${safe}/multisig-transactions/` +
      `?executed=false&ordering=nonce&limit=${PAGE_SIZE}&offset=${offset}`;
    const json = await getJson(a.chainId, path);
    if (json === null) return out; // Safe unknown to the service (not indexed yet)
    const { results, count } = shaped("GET", path, () => {
      const env = obj(json, "page");
      if (!Array.isArray(env.results)) throw new ShapeError("results is not an array");
      return {
        results: env.results.map(parseMultisigTx),
        count: typeof env.count === "number" ? env.count : null,
      };
    });
    out.push(...results);
    if (results.length < PAGE_SIZE) break;
    if (count !== null && offset + results.length >= count) break;
  }
  return out;
}

/**
 * Propose a tx with the proposer's own signature. `sender` must be a Safe
 * owner and `signature` its signature over `safeTxHash` (the service
 * recomputes the hash and rejects a mismatch).
 */
export async function proposeTransaction(a: {
  chainId: number;
  safeAddress: Address;
  tx: SafeTx;
  safeTxHash: Hex;
  sender: Address;
  signature: Hex;
  origin?: string;
}): Promise<void> {
  const safe = getAddress(a.safeAddress);
  await postJson(a.chainId, `/v2/safes/${safe}/multisig-transactions/`, {
    safe,
    to: getAddress(a.tx.to),
    value: a.tx.value.toString(),
    data: a.tx.data === "0x" ? null : a.tx.data,
    operation: a.tx.operation,
    gasToken: a.tx.gasToken,
    safeTxGas: a.tx.safeTxGas.toString(),
    baseGas: a.tx.baseGas.toString(),
    gasPrice: a.tx.gasPrice.toString(),
    refundReceiver: a.tx.refundReceiver,
    nonce: a.tx.nonce.toString(),
    contractTransactionHash: a.safeTxHash,
    sender: getAddress(a.sender),
    signature: a.signature,
    origin: a.origin ?? "La Caisse",
  });
}

export async function confirmTransaction(a: {
  chainId: number;
  safeTxHash: Hex;
  signature: Hex;
}): Promise<void> {
  await postJson(a.chainId, `/v1/multisig-transactions/${a.safeTxHash}/confirmations/`, {
    signature: a.signature,
  });
}
