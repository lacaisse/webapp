// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeEventTopics,
  getAddress,
  hexToBigInt,
  http,
  parseEventLogs,
  toHex,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { gnosis } from "viem/chains";

import { alchemyNetwork } from "@/services/alchemy/client";
import { SAFE_ABI, SAFE_PROXY_FACTORY_ABI } from "@/services/safe/abi";
import { safeContractsFor } from "@/services/safe/config";
import { predictSafeAddress, safeSetupData } from "@/services/safe/safe-tx";
import { SafeError, type Address, type Hex, type SafeTx } from "@/services/safe/types";

// Chain I/O for the Safe feature, through La Caisse's relayer EOA
// (`SAFE_RELAYER_PRIVATE_KEY`, funded with xDAI). The relayer deploys Safes
// and broadcasts fully-signed `execTransaction` calls; it is never a Safe
// owner, so it can't move funds on its own — it only pays gas.
// RPC is Alchemy (`ALCHEMY_API_KEY`), same endpoint as services/alchemy.
// Module map: services/safe/config.ts.
//
// Errors are SafeError. When a tx was broadcast, the error carries its hash
// as a `txHash` property — read it with `errorTxHash(e)` to persist it.
//
// Nonces: viem fetches the relayer's pending nonce per send. Two sends racing
// (the cron and an operator action at the same moment) can collide on a nonce;
// the loser fails with relayer_failed before broadcast and is retried by the
// caller. Acceptable for v1's volume; a per-relayer lock would fix it.

const CHAIN_BY_ID: Record<number, Chain> = {
  100: gnosis,
};

const RECEIPT_TIMEOUT_MS = 90_000;
// execTransaction with safeTxGas 0 forwards (almost) all remaining gas to the
// inner call, so a bare estimate can be marginal under the 63/64 rule.
const GAS_BUFFER_NUM = BigInt(12);
const GAS_BUFFER_DEN = BigInt(10);

// Revert reasons of Safe 1.4.1 (GSxxx codes) worth explaining to operators.
const SAFE_REVERT_REASONS: Record<string, string> = {
  GS001: "threshold not set",
  GS010: "not enough gas to execute the Safe transaction",
  GS013: "the transaction's inner call failed",
  GS020: "signatures data too short",
  GS021: "invalid contract signature location",
  GS022: "invalid contract signature location",
  GS023: "invalid contract signature location",
  GS024: "invalid contract signature",
  GS025: "hash not approved",
  GS026: "invalid owner provided (signer not an owner, or signatures out of order)",
  GS031: "method can only be called from this contract",
};

export type SafeErrorWithTxHash = SafeError & { txHash?: Hex };

function withTxHash(err: SafeError, txHash: Hex): SafeErrorWithTxHash {
  return Object.assign(err, { txHash });
}

/** The broadcast tx hash attached to a relayer error, if one was sent. */
export function errorTxHash(e: unknown): Hex | null {
  if (typeof e !== "object" || e === null) return null;
  const h = (e as { txHash?: unknown }).txHash;
  return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) ? (h as Hex) : null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function relayerKey(): Hex | null {
  const raw = process.env.SAFE_RELAYER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `0x${hex}`;
}

export function isRelayerConfigured(): boolean {
  return relayerKey() !== null;
}

export function relayerAddress(): Address | null {
  const key = relayerKey();
  return key ? privateKeyToAccount(key).address : null;
}

function requireRelayerAccount(): PrivateKeyAccount {
  const key = relayerKey();
  if (!key) {
    throw new SafeError(
      "relayer_not_configured",
      "SAFE_RELAYER_PRIVATE_KEY is not set (or is not a 32-byte hex key)",
    );
  }
  return privateKeyToAccount(key);
}

function chainFor(chainId: number): Chain {
  const chain = CHAIN_BY_ID[chainId];
  if (!chain) {
    throw new SafeError("unsupported_chain", `No chain config for chainId ${chainId}`);
  }
  return chain;
}

function rpcUrl(chainId: number): string {
  const network = alchemyNetwork(chainId);
  if (!network) {
    throw new SafeError("unsupported_chain", `No Alchemy network for chainId ${chainId}`);
  }
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new SafeError("config", "ALCHEMY_API_KEY is not set");
  return `https://${network}.g.alchemy.com/v2/${key}`;
}

export function publicClientFor(chainId: number): PublicClient {
  return createPublicClient({ chain: chainFor(chainId), transport: http(rpcUrl(chainId)) });
}

function walletClientFor(chainId: number) {
  return createWalletClient({
    account: requireRelayerAccount(),
    chain: chainFor(chainId),
    transport: http(rpcUrl(chainId)),
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Relayer xDAI balance in wei. */
export async function relayerBalance(chainId: number): Promise<bigint> {
  const account = requireRelayerAccount();
  return publicClientFor(chainId).getBalance({ address: account.address });
}

async function hasCode(client: PublicClient, address: Address): Promise<boolean> {
  const code = await client.getCode({ address });
  return !!code && code !== "0x";
}

export async function readSafeState(a: {
  chainId: number;
  safeAddress: Address;
}): Promise<{ deployed: boolean; owners: Address[]; threshold: number; nonce: number }> {
  const client = publicClientFor(a.chainId);
  const address = getAddress(a.safeAddress);
  if (!(await hasCode(client, address))) {
    return { deployed: false, owners: [], threshold: 0, nonce: 0 };
  }
  const [owners, threshold, nonce] = await Promise.all([
    client.readContract({ address, abi: SAFE_ABI, functionName: "getOwners" }),
    client.readContract({ address, abi: SAFE_ABI, functionName: "getThreshold" }),
    client.readContract({ address, abi: SAFE_ABI, functionName: "nonce" }),
  ]);
  return {
    deployed: true,
    owners: owners.map((o) => getAddress(o)),
    threshold: Number(threshold),
    nonce: Number(nonce),
  };
}

// How far back findSafeExecution scans for the Safe's execution events.
// Gnosis mines ~17k blocks a day; the cron reconciles every 2 minutes, so a
// week covers any realistic gap. Alchemy caps an eth_getLogs call at 10 000
// blocks (-32600 "You can make eth_getLogs requests with up to a 10000 block
// range"), so the window is walked in chunks of that size, newest first: the
// execution we are looking for is almost always in the latest chunk.
const EXECUTION_LOOKBACK_BLOCKS = BigInt(120_000);
export const EXECUTION_SCAN_CHUNK_BLOCKS = BigInt(10_000);

/**
 * Chain-only answer to "did this SafeTx execute?": the Safe emits
 * ExecutionSuccess / ExecutionFailure with the safeTxHash as indexed topic.
 * Independent of the Transaction Service, so a lost receipt or bookkeeping
 * failure can be reconciled from the chain alone. Null when no event is
 * found in the lookback window. One eth_getLogs call per chunk carries both
 * events (two topic-0 alternatives, the hash as topic 1).
 */
export async function findSafeExecution(a: {
  chainId: number;
  safeAddress: Address;
  safeTxHash: Hex;
}): Promise<{ txHash: Hex; success: boolean; blockNumber: bigint } | null> {
  const client = publicClientFor(a.chainId);
  const address = getAddress(a.safeAddress);
  const latest = await client.getBlockNumber();
  const floor =
    latest >= EXECUTION_LOOKBACK_BLOCKS ? latest - EXECUTION_LOOKBACK_BLOCKS + BigInt(1) : BigInt(0);
  const [successTopic, hashTopic] = encodeEventTopics({
    abi: SAFE_ABI,
    eventName: "ExecutionSuccess",
    args: { txHash: a.safeTxHash },
  });
  const [failureTopic] = encodeEventTopics({ abi: SAFE_ABI, eventName: "ExecutionFailure" });
  if (!successTopic || !failureTopic || !hashTopic) {
    throw new SafeError("config", "Execution events missing from SAFE_ABI");
  }

  let toBlock = latest;
  while (toBlock >= floor) {
    const span = EXECUTION_SCAN_CHUNK_BLOCKS - BigInt(1);
    const fromBlock = toBlock - span > floor ? toBlock - span : floor;
    const logs = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address,
          topics: [[successTopic, failureTopic], hashTopic],
          fromBlock: toHex(fromBlock),
          toBlock: toHex(toBlock),
        },
      ],
    });
    const found = logs
      .filter((l) => l.blockNumber !== null && l.transactionHash !== null)
      .map((l) => ({
        txHash: l.transactionHash as Hex,
        success: l.topics[0] === successTopic,
        blockNumber: hexToBigInt(l.blockNumber as Hex),
      }))
      .sort((x, y) => (x.blockNumber < y.blockNumber ? -1 : x.blockNumber > y.blockNumber ? 1 : 0));
    if (found[0]) return found[0];
    if (fromBlock === BigInt(0)) break;
    toBlock = fromBlock - BigInt(1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Deploy a Safe 1.4.1 proxy (SafeL2 singleton, CompatibilityFallbackHandler)
 * via SafeProxyFactory.createProxyWithNonce. Idempotent for a crash after the
 * deployment mined: if the predicted address already has code, it returns it
 * with txHash "0x" and sends nothing. (If a previous send is still pending,
 * a re-run sends a second create that reverts on the CREATE2 collision —
 * tx_reverted, harmless; the next sync sees the Safe deployed.)
 */
export async function deploySafe(a: {
  chainId: number;
  owners: Address[];
  threshold: number;
  saltNonce: bigint;
}): Promise<{ address: Address; txHash: Hex }> {
  if (a.owners.length === 0 || a.threshold < 1 || a.threshold > a.owners.length) {
    throw new SafeError(
      "invalid_state",
      `Invalid Safe setup: ${a.threshold}-of-${a.owners.length}`,
    );
  }
  const contracts = safeContractsFor(a.chainId);
  const client = publicClientFor(a.chainId);
  const wallet = walletClientFor(a.chainId);

  const initializer = safeSetupData({
    owners: a.owners,
    threshold: BigInt(a.threshold),
    fallbackHandler: contracts.fallbackHandler,
  });
  const proxyCreationCode = await client.readContract({
    address: contracts.proxyFactory,
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: "proxyCreationCode",
  });
  const predicted = predictSafeAddress({
    proxyFactory: contracts.proxyFactory,
    singleton: contracts.singleton,
    initializer,
    saltNonce: a.saltNonce,
    proxyCreationCode,
  });
  if (await hasCode(client, predicted)) {
    return { address: predicted, txHash: "0x" };
  }

  let txHash: Hex;
  try {
    txHash = await wallet.writeContract({
      address: contracts.proxyFactory,
      abi: SAFE_PROXY_FACTORY_ABI,
      functionName: "createProxyWithNonce",
      args: [contracts.singleton, initializer, a.saltNonce],
    });
  } catch (e) {
    throw new SafeError("relayer_failed", `Safe deployment not sent: ${shortMessage(e)}`, {
      cause: e,
    });
  }

  const receipt = await waitForReceipt(client, txHash, "Safe deployment");
  if (receipt.status !== "success") {
    throw withTxHash(
      new SafeError("tx_reverted", `Safe deployment reverted (tx ${txHash})`),
      txHash,
    );
  }
  const created = parseEventLogs({
    abi: SAFE_PROXY_FACTORY_ABI,
    eventName: "ProxyCreation",
    logs: receipt.logs.filter(
      (l) => l.address.toLowerCase() === contracts.proxyFactory.toLowerCase(),
    ),
  });
  const proxy = created[0]?.args.proxy;
  if (!proxy || getAddress(proxy) !== predicted) {
    throw withTxHash(
      new SafeError(
        "relayer_failed",
        `ProxyCreation ${proxy ?? "missing"} does not match predicted ${predicted} (tx ${txHash})`,
      ),
      txHash,
    );
  }
  return { address: predicted, txHash };
}

// ---------------------------------------------------------------------------
// execTransaction
// ---------------------------------------------------------------------------

function execArgs(tx: SafeTx, signatures: Hex) {
  return [
    tx.to,
    tx.value,
    tx.data,
    tx.operation,
    tx.safeTxGas,
    tx.baseGas,
    tx.gasPrice,
    tx.gasToken,
    tx.refundReceiver,
    signatures,
  ] as const;
}

/**
 * Dry-run execTransaction from the relayer. Throws SafeError("tx_reverted",
 * "<GSxxx>: <explanation>") when the Safe would revert (bad/missing
 * signatures, inner call failure, …); relayer_failed for RPC trouble.
 */
export async function simulateSafeTransaction(a: {
  chainId: number;
  safeAddress: Address;
  tx: SafeTx;
  signatures: Hex;
}): Promise<void> {
  const account = requireRelayerAccount();
  const client = publicClientFor(a.chainId);
  let ok: boolean;
  try {
    const { result } = await client.simulateContract({
      account: account.address,
      address: getAddress(a.safeAddress),
      abi: SAFE_ABI,
      functionName: "execTransaction",
      args: execArgs(a.tx, a.signatures),
    });
    ok = result;
  } catch (e) {
    throw mapSimulationError(e);
  }
  // Only reachable with a non-zero safeTxGas/gasPrice; ours are always zero
  // (the Safe reverts GS013 instead), kept as a guard.
  if (!ok) throw new SafeError("tx_reverted", "Safe transaction inner call failed");
}

/**
 * Simulate, then broadcast execTransaction from the relayer and wait for the
 * receipt (90 s). The Safe emits ExecutionFailure and returns normally when
 * the inner call fails with a non-zero safeTxGas; that is treated as a revert
 * too. Every error after broadcast carries the tx hash (`errorTxHash`). A
 * receipt timeout is relayer_failed — the tx may still mine, so reconcile via
 * sync rather than resending blindly.
 */
export async function execSafeTransaction(a: {
  chainId: number;
  safeAddress: Address;
  tx: SafeTx;
  signatures: Hex;
}): Promise<{ txHash: Hex }> {
  await simulateSafeTransaction(a);

  const client = publicClientFor(a.chainId);
  const wallet = walletClientFor(a.chainId);
  const safeAddress = getAddress(a.safeAddress);
  const request = {
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "execTransaction" as const,
    args: execArgs(a.tx, a.signatures),
  };

  let txHash: Hex;
  try {
    const estimate = await client.estimateContractGas({
      ...request,
      account: wallet.account,
    });
    txHash = await wallet.writeContract({
      ...request,
      gas: (estimate * GAS_BUFFER_NUM) / GAS_BUFFER_DEN,
    });
  } catch (e) {
    throw new SafeError("relayer_failed", `execTransaction not sent: ${shortMessage(e)}`, {
      cause: e,
    });
  }

  const receipt = await waitForReceipt(client, txHash, "execTransaction");
  if (receipt.status !== "success") {
    throw withTxHash(
      new SafeError("tx_reverted", `execTransaction reverted (tx ${txHash})`),
      txHash,
    );
  }
  const failures = parseEventLogs({
    abi: SAFE_ABI,
    eventName: "ExecutionFailure",
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === safeAddress.toLowerCase()),
  });
  if (failures.length > 0) {
    throw withTxHash(
      new SafeError("tx_reverted", `inner call failed (ExecutionFailure, tx ${txHash})`),
      txHash,
    );
  }
  return { txHash };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function waitForReceipt(
  client: PublicClient,
  txHash: Hex,
  what: string,
): Promise<TransactionReceipt> {
  try {
    return await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  } catch (e) {
    throw withTxHash(
      new SafeError(
        "relayer_failed",
        `${what} sent (tx ${txHash}) but no receipt yet: ${shortMessage(e)}`,
        { cause: e },
      ),
      txHash,
    );
  }
}

function shortMessage(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message : String(e);
}

/** Map a viem simulate error to a SafeError, decoding Safe's GSxxx reason. */
export function mapSimulationError(e: unknown): SafeError {
  if (e instanceof BaseError) {
    const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const reason = reverted.reason ?? reverted.data?.errorName ?? null;
      const explained = reason && SAFE_REVERT_REASONS[reason];
      const message = reason
        ? explained
          ? `${reason}: ${explained}`
          : reason
        : "execTransaction would revert";
      return new SafeError("tx_reverted", message, { cause: e });
    }
  }
  return new SafeError("relayer_failed", `Simulation failed: ${shortMessage(e)}`, { cause: e });
}
