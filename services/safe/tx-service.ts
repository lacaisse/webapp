// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress } from "viem";

import {
  ShapeError,
  addr,
  addrOrNull,
  hex,
  hexOrNull,
  int,
  obj,
  shaped as shapedWith,
  str,
  strOrNull,
} from "@/services/http/shape";
import { queueServiceBaseUrl, txServiceBaseUrl } from "@/services/safe/config";
import {
  queueConfirmTransaction,
  queueGetMultisigTransaction,
  queueListPendingTransactions,
  queueProposeTransaction,
} from "@/services/safe/queue-service";
import { getSafeApiJson, safeApiHttpError, sendSafeApi } from "@/services/safe/safe-api-http";
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
//
// Safe is replacing the queue endpoints above (proposals, confirmations,
// pending list) with the Safe Queue Service (queue-service.ts). This module
// stays the one import surface: when `SAFE_TX_SERVICE_URL` names a Queue
// Service base (config.ts queueServiceBaseUrl) the four queue functions go
// there and return the same normalised shapes; otherwise they use the
// Transaction Service as before. `getSafeInfo` is on-chain data and always
// stays on the Transaction Service.
//
// Auth, timeout and error mapping: safe-api-http.ts.

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export type TxServiceConfirmation = {
  owner: Address;
  signature: Hex | null;
  signatureType: string | null;
  submissionDate: string;
};

// One shape for both services. From the Queue Service: `isExecuted` is
// "txHash is set", `isSuccessful` the inverse of `failed`, `submissionDate`
// is `created`; `executionDate` and `confirmationsRequired` are always null
// (the service has neither) and addresses are checksummed here.
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
// HTTP (shared plumbing: safe-api-http.ts)
// ---------------------------------------------------------------------------

function baseFor(chainId: number): string {
  const base = txServiceBaseUrl(chainId);
  if (!base) {
    throw new SafeError("unsupported_chain", `No Safe Transaction Service for chain ${chainId}`);
  }
  return base;
}

async function getJson(chainId: number, path: string): Promise<unknown | null> {
  return getSafeApiJson(baseFor(chainId), path);
}

// A re-submission the service already has: the proposal or confirmation is in
// place, which is all we wanted. An "already executed" answer is NOT benign
// (the nonce is spent) and still throws.
const ALREADY_THERE = /already (exists|confirmed|been confirmed)|duplicate/i;

async function postJson(chainId: number, path: string, body: unknown): Promise<void> {
  const r = await sendSafeApi(baseFor(chainId), "POST", path, body);
  if (r.status >= 200 && r.status < 300) return;
  if ((r.status === 400 || r.status === 422) && ALREADY_THERE.test(r.text) && !/executed/i.test(r.text)) {
    return;
  }
  throw safeApiHttpError("POST", path, r);
}

// ---------------------------------------------------------------------------
// Shape parsing (helpers: services/http/shape.ts)
// ---------------------------------------------------------------------------

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
  return shapedWith(
    parse,
    (e) => new SafeError("tx_service", `${method} ${path}: unexpected response (${e.message})`),
  );
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
  const queue = queueServiceBaseUrl();
  if (queue) return queueGetMultisigTransaction(queue, a);
  const path = `/v2/multisig-transactions/${a.safeTxHash}/`;
  const json = await getJson(a.chainId, path);
  return json === null ? null : shaped("GET", path, () => parseMultisigTx(json));
}

/** Not-yet-executed (trusted) txs for the Safe, nonce ascending, ≤ 500. */
export async function listPendingTransactions(a: {
  chainId: number;
  safeAddress: Address;
}): Promise<TxServiceMultisigTx[]> {
  const queue = queueServiceBaseUrl();
  if (queue) return queueListPendingTransactions(queue, a);
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
 * recomputes the hash and rejects a mismatch). On either service a proposal
 * that is already there is a success, and the signature ends up stored.
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
  const queue = queueServiceBaseUrl();
  if (queue) return queueProposeTransaction(queue, a);
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
  const queue = queueServiceBaseUrl();
  if (queue) return queueConfirmTransaction(queue, a);
  await postJson(a.chainId, `/v1/multisig-transactions/${a.safeTxHash}/confirmations/`, {
    signature: a.signature,
  });
}
