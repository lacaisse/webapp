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
import {
  getSafeApiJson,
  parseSafeApiJson,
  safeApiHttpError,
  sendSafeApi,
} from "@/services/safe/safe-api-http";
import { ZERO_ADDRESS, sameAddress } from "@/services/safe/safe-tx";
import type { TxServiceConfirmation, TxServiceMultisigTx } from "@/services/safe/tx-service";
import { SafeError, type Address, type Hex, type SafeTx } from "@/services/safe/types";

// Safe Queue Service HTTP client (no SDK): the service that replaces the
// off-chain queue endpoints of the Safe Transaction Service. Not imported
// directly — tx-service.ts routes its queue functions here when
// `SAFE_TX_SERVICE_URL` names a Queue Service (config.ts queueServiceBaseUrl),
// and every function returns the shapes tx-service.ts declares.
//
// Written from the migration guide and the OpenAPI schema of service v0.10.1
// (docs.safe.global/core-api/safe-queue-service-migration, 2026-11-24):
//   GET  /api/v1/multisig-transactions/{safeTxHash}             confirmations embedded
//   GET  /api/v1/multisig-transactions/queue?safes={safe}:{chainId}
//                                                               paginated { count, next, results }
//   POST /api/v1/multisig-transactions                          201, the transaction
//   POST /api/v1/multisig-transactions/{safeTxHash}/signatures  201, the new confirmations
// One base for all chains, no trailing slashes. What differs from the
// Transaction Service and is handled here:
//   - An unknown or snake_case query parameter is ignored without an error
//     (200, unfiltered), so the names below are exactly the schema's; `limit`
//     above 100 is a 422.
//   - `/queue` already returns only unexecuted transactions at or above the
//     Safe's current nonce.
//   - Addresses come back lowercase, and `to` / `gasToken` / `refundReceiver`
//     are null for the zero address.
//   - Duplicates are 409: a proposal whose hash is stored, an owner that
//     already confirmed. A repeated proposal no longer adds its signature.
//   - Rejections are 422 with `detail` a string or a list; 503 is "chain not
//     supported" or "chain information unavailable right now".

const PAGE_SIZE = 100; // the service's maximum
const MAX_PAGES = 5;
const ORIGIN_NAME_MAX = 100;

// ---------------------------------------------------------------------------
// Shape parsing
// ---------------------------------------------------------------------------

function parseConfirmation(v: unknown): TxServiceConfirmation {
  const c = obj(v, "confirmation");
  return {
    owner: addr(c.owner, "confirmation.owner"),
    signature: hexOrNull(c.signature, "confirmation.signature"),
    signatureType: strOrNull(c.signatureType, "confirmation.signatureType"),
    submissionDate: str(c.created, "confirmation.created"),
  };
}

type QueueTx = TxServiceMultisigTx & { chainId: number };

function parseQueueTx(v: unknown): QueueTx {
  const t = obj(v, "multisig transaction");
  const confirmations = t.confirmations ?? [];
  if (!Array.isArray(confirmations)) throw new ShapeError("confirmations is not an array");
  if (typeof t.value !== "string" || !/^\d+$/.test(t.value)) {
    throw new ShapeError("value is not an integer");
  }
  const txHash = hexOrNull(t.txHash, "txHash");
  return {
    chainId: int(t.chainId, "chainId"),
    safe: addr(t.safe, "safe"),
    safeTxHash: hex(t.safeTxHash, "safeTxHash"),
    nonce: int(t.nonce, "nonce"),
    to: addrOrNull(t.to, "to") ?? ZERO_ADDRESS,
    value: t.value,
    data: hexOrNull(t.data, "data"),
    operation: int(t.operation, "operation"),
    isExecuted: txHash !== null,
    isSuccessful: typeof t.failed === "boolean" ? !t.failed : null,
    transactionHash: txHash,
    executionDate: null,
    submissionDate: str(t.created, "created"),
    confirmations: confirmations.map(parseConfirmation),
    confirmationsRequired: null,
    proposer: addrOrNull(t.proposer, "proposer"),
  };
}

function shaped<T>(method: string, path: string, parse: () => T): T {
  return shapedWith(
    parse,
    (e) => new SafeError("tx_service", `${method} ${path}: unexpected response (${e.message})`),
  );
}

function withoutChain(tx: QueueTx): TxServiceMultisigTx {
  const out: TxServiceMultisigTx & { chainId?: number } = { ...tx };
  delete out.chainId;
  return out;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function queueGetMultisigTransaction(
  base: string,
  a: { chainId: number; safeTxHash: Hex },
): Promise<TxServiceMultisigTx | null> {
  const path = `/api/v1/multisig-transactions/${a.safeTxHash}`;
  const json = await getSafeApiJson(base, path);
  if (json === null) return null;
  const tx = shaped("GET", path, () => parseQueueTx(json));
  // The path takes no chain: the hash names the transaction, on whatever
  // chain it is. One on another chain is not the one asked for.
  return tx.chainId === a.chainId ? withoutChain(tx) : null;
}

/** Pending txs the Safe can still execute, nonce ascending, ≤ 500. */
export async function queueListPendingTransactions(
  base: string,
  a: { chainId: number; safeAddress: Address },
): Promise<TxServiceMultisigTx[]> {
  const safe = getAddress(a.safeAddress);
  const out: TxServiceMultisigTx[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const path =
      `/api/v1/multisig-transactions/queue` +
      `?safes=${safe}:${a.chainId}&nonceOrder=asc&limit=${PAGE_SIZE}&offset=${offset}`;
    // No 404 here: a Safe the service can't find is a 422 and an unsupported
    // chain a 503. Both throw; sync logs it and carries on without the list.
    const r = await sendSafeApi(base, "GET", path);
    if (r.status < 200 || r.status >= 300) throw safeApiHttpError("GET", path, r);
    const json = parseSafeApiJson("GET", path, r);
    const { results, count } = shaped("GET", path, () => {
      const env = obj(json, "page");
      if (!Array.isArray(env.results)) throw new ShapeError("results is not an array");
      return {
        results: env.results.map(parseQueueTx),
        count: typeof env.count === "number" ? env.count : null,
      };
    });
    // Had the `safes` filter been dropped (a renamed parameter is ignored,
    // not refused), the page would hold other Safes' transactions.
    for (const tx of results) {
      if (tx.chainId === a.chainId && sameAddress(tx.safe, safe)) out.push(withoutChain(tx));
    }
    if (results.length < PAGE_SIZE) break;
    if (count !== null && offset + results.length >= count) break;
  }
  return out;
}

async function postSignatures(base: string, safeTxHash: Hex, signature: Hex): Promise<void> {
  const path = `/api/v1/multisig-transactions/${safeTxHash}/signatures`;
  const r = await sendSafeApi(base, "POST", path, { signatures: [signature] });
  if (r.status >= 200 && r.status < 300) return;
  // 409: this owner already confirmed — in place, which is all we wanted. An
  // executed transaction (the nonce is spent) is a 422 and still throws.
  if (r.status === 409) return;
  throw safeApiHttpError("POST", path, r);
}

/**
 * Propose a tx with the proposer's own signature (an owner's: La Caisse has
 * no delegates). The service computes the safeTxHash itself; a hash that
 * differs from ours shows as a 422 "signer is not an owner".
 */
export async function queueProposeTransaction(
  base: string,
  a: {
    chainId: number;
    safeAddress: Address;
    tx: SafeTx;
    safeTxHash: Hex;
    sender: Address;
    signature: Hex;
    origin?: string;
  },
): Promise<void> {
  const path = `/api/v1/multisig-transactions`;
  const apex = process.env.APP_DOMAIN?.trim();
  const r = await sendSafeApi(base, "POST", path, {
    chainId: a.chainId,
    safe: getAddress(a.safeAddress),
    to: getAddress(a.tx.to),
    // Decimal strings: accepted for every number, and exact above 2^53.
    value: a.tx.value.toString(),
    data: a.tx.data === "0x" ? null : a.tx.data,
    operation: a.tx.operation,
    gasToken: a.tx.gasToken,
    safeTxGas: a.tx.safeTxGas.toString(),
    baseGas: a.tx.baseGas.toString(),
    gasPrice: a.tx.gasPrice.toString(),
    refundReceiver: a.tx.refundReceiver,
    nonce: a.tx.nonce.toString(),
    signatures: [a.signature],
    originName: (a.origin ?? "La Caisse").slice(0, ORIGIN_NAME_MAX),
    originUrl: apex && apex !== "localhost" ? `https://${apex}` : null,
  });
  if (r.status >= 200 && r.status < 300) return;
  if (r.status === 409) {
    // The hash is already stored (our own retry, or an owner proposed the
    // same transaction in Safe{Wallet}). Unlike the Transaction Service, a
    // repeated proposal does not add its signature: send it on its own.
    await postSignatures(base, a.safeTxHash, a.signature);
    return;
  }
  throw safeApiHttpError("POST", path, r);
}

export async function queueConfirmTransaction(
  base: string,
  a: { chainId: number; safeTxHash: Hex; signature: Hex },
): Promise<void> {
  await postSignatures(base, a.safeTxHash, a.signature);
}
