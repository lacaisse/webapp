// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  concatHex,
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arbitrum,
  base,
  gnosis,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";

import { decryptSecret } from "@/services/crypto/secret";

// ERC-4337 UserOperation builder + submitter for CitizenPay's Safe-account
// bundler. Used by mint/burn flows to push gasless transactions through
// CP's paymaster.
//
// The Safe smart account is reached via execTransactionFromModule — every
// userop wraps the inner ERC20 call (mint / burnFrom / transfer) inside a
// Safe module call. The minter EOA owns the Safe (counterfactually deployed
// on first userop) and signs the userOpHash with personal_sign (EIP-191).
//
// CP's bundler URL is structured `/v1/{chainId}/rpc/{pm_address}` — the
// paymaster contract address is bound into the URL path (NOT the request
// body) and the chain id is also a path segment. The bundler exposes
// two custom JSON-RPC methods we hit directly:
//   - pm_ooSponsorUserOperation  → returns the userop with gas+fees+paymasterAndData filled
//   - eth_sendUserOperation      → returns the on-chain tx hash (not the userOpHash)
// Smart-account existence is checked via `GET /v1/{chainId}/accounts/{sender}/exists`
// on the same host (no separate node service).
//
// Salt nonce for SafeAccountFactory.createAccount is hard-coded to 0 to
// match services/token/smart-account.ts — one Safe per minter EOA.

// =============================================================================
// Config
// =============================================================================

const SALT_NONCE = BigInt(0);
const SAFE_OP_CALL = 0; // enum Enum.Operation: 0 = Call, 1 = DelegateCall
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// Bundler-poll cadence for awaiting a userop. `eth_sendUserOperation`
// returns immediately with the userop hash and queues async on-chain
// submission, so we poll `pm_getUserOpTxHash` until the bundler reports
// a terminal state. Gnosis block time is ~5s, so a 1s interval gives a
// reasonable balance between latency and bundler load. The total budget
// covers two block confirmations plus margin.
const USEROP_POLL_INTERVAL_MS = 1_000;
const USEROP_POLL_TIMEOUT_MS = 60_000;

const CHAIN_BY_ID: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  100: gnosis,
  137: polygon,
  8453: base,
  42161: arbitrum,
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new UserOpError("config", `${name} is not configured`);
  return v;
}

// =============================================================================
// ABIs
// =============================================================================

const ENTRYPOINT_ABI = [
  {
    type: "function",
    name: "getUserOpHash",
    stateMutability: "view",
    inputs: [
      {
        name: "userOp",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "callGasLimit", type: "uint256" },
          { name: "verificationGasLimit", type: "uint256" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "maxFeePerGas", type: "uint256" },
          { name: "maxPriorityFeePerGas", type: "uint256" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const FACTORY_ABI = [
  {
    type: "function",
    name: "createAccount",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const SAFE_ABI = [
  {
    type: "function",
    name: "execTransactionFromModule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "burnFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "MINTER_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "BURNER_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

// =============================================================================
// Types
// =============================================================================

export type UserOp = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
};

export type JsonUserOp = {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type FundMinterContext = {
  id: string;
  tokenAddress: string | null;
  tokenChainId: number;
  tokenMinterPrivateKeyEnc: string | null;
  tokenMinterEoaAddress: string | null;
  tokenMinterSmartAccountAddress: string | null;
  // CP-provided 4337 stack identity. Required for mint/burn — without it
  // we'd be guessing entrypoint/factory/paymaster addresses. Populated by
  // services/citizenpay/sync.ts on every (re)connect.
  citizenPayEntrypointAddress: string | null;
  citizenPayAccountFactoryAddress: string | null;
  citizenPayPaymasterAddress: string | null;
  citizenPayPaymasterType: string | null;
};

export class UserOpError extends Error {
  constructor(
    public readonly code:
      | "config"
      | "fund_not_provisioned"
      | "no_token"
      | "unsupported_chain"
      | "sponsor_failed"
      | "submit_failed"
      | "tx_failed"
      | "missing_role",
    message: string,
  ) {
    super(message);
    this.name = "UserOpError";
  }
}

// =============================================================================
// JSON serialisation (bundler RPC)
// =============================================================================

// Hex-encode a uint without a leading zero nibble. Matches the ethers
// reference `toBeHex(v).replace("0x0", "0x")`:
//   0   → "0x0"     (single digit — JSON-RPC QUANTITY requires ≥1 digit)
//   1   → "0x1"
//   15  → "0xf"
//   16  → "0x10"
//   256 → "0x100"
// Earlier we returned "0x" for zero; CP's bundler rejects that with a
// 502 because "0x" is valid DATA but invalid QUANTITY per the JSON-RPC
// spec. Six zero-quantity fields per pre-sponsor userop made the upstream
// hang and Cloudflare reported "Application failed to respond".
function toQuantity(v: bigint): Hex {
  if (v === BigInt(0)) return "0x0";
  return ("0x" + v.toString(16)) as Hex;
}

export function userOpToJson(op: UserOp): JsonUserOp {
  return {
    sender: op.sender,
    nonce: toQuantity(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    callGasLimit: toQuantity(op.callGasLimit),
    verificationGasLimit: toQuantity(op.verificationGasLimit),
    preVerificationGas: toQuantity(op.preVerificationGas),
    maxFeePerGas: toQuantity(op.maxFeePerGas),
    maxPriorityFeePerGas: toQuantity(op.maxPriorityFeePerGas),
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

export function userOpFromJson(json: JsonUserOp): UserOp {
  const q = (h: Hex): bigint => (h === "0x" ? BigInt(0) : BigInt(h));
  return {
    sender: json.sender,
    nonce: q(json.nonce),
    initCode: json.initCode,
    callData: json.callData,
    callGasLimit: q(json.callGasLimit),
    verificationGasLimit: q(json.verificationGasLimit),
    preVerificationGas: q(json.preVerificationGas),
    maxFeePerGas: q(json.maxFeePerGas),
    maxPriorityFeePerGas: q(json.maxPriorityFeePerGas),
    paymasterAndData: json.paymasterAndData,
    signature: json.signature,
  };
}

// =============================================================================
// Calldata builders (Safe variants)
// =============================================================================

/** Wrap any inner call so it executes from the Safe via the module call. */
export function executeSafeCallData(
  to: Address,
  value: bigint,
  data: Hex,
): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "execTransactionFromModule",
    args: [to, value, data, SAFE_OP_CALL],
  });
}

export function safeMintCallData(
  token: Address,
  to: Address,
  amount: bigint,
): Hex {
  const inner = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "mint",
    args: [to, amount],
  });
  return executeSafeCallData(token, BigInt(0), inner);
}

export function safeBurnFromCallData(
  token: Address,
  from: Address,
  amount: bigint,
): Hex {
  const inner = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "burnFrom",
    args: [from, amount],
  });
  return executeSafeCallData(token, BigInt(0), inner);
}

export function safeTransferCallData(
  token: Address,
  to: Address,
  amount: bigint,
): Hex {
  const inner = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
  return executeSafeCallData(token, BigInt(0), inner);
}

// =============================================================================
// initCode (lazy SA deployment)
// =============================================================================

function initCodeFor(
  factory: Address,
  owner: Address,
  saltNonce: bigint = SALT_NONCE,
): Hex {
  const createCall = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "createAccount",
    args: [owner, saltNonce],
  });
  return concatHex([factory, createCall]);
}

async function senderAccountExists(
  client: PublicClient,
  chainId: number,
  sender: Address,
): Promise<boolean> {
  // Primary: bundler's `/v1/{chainId}/accounts/{sender}/exists` — 200 OK
  // means deployed, 404 means not yet. Falls back to `eth_getCode` if the
  // bundler is unreachable / misconfigured, so existence detection still
  // works in tests where only the chain RPC is wired.
  const bundlerRoot = process.env.CITIZENPAY_BUNDLER_URL;
  if (bundlerRoot) {
    try {
      const res = await fetch(
        `${bundlerRoot.replace(/\/$/, "")}/v1/${chainId}/accounts/${sender}/exists`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (res.status === 200) return true;
      if (res.status === 404) return false;
    } catch {
      // Fall through to on-chain check.
    }
  }
  const code = await client.getCode({ address: sender });
  return code != null && code !== "0x";
}

// =============================================================================
// RPC clients
// =============================================================================

function publicClientFor(chainId: number): PublicClient {
  const chain = CHAIN_BY_ID[chainId];
  if (!chain) {
    throw new UserOpError(
      "unsupported_chain",
      `No chain config for chainId ${chainId}`,
    );
  }
  // The bundler URL is itself a full JSON-RPC node (it already answers
  // eth_getTransactionReceipt / eth_call here). Use its chain-scoped read
  // endpoint for the plain chain reads in the userop flow — getUserOpHash,
  // the account-existence fallback, and post-failure role checks — so the
  // whole mint/burn/transfer submission path depends only on the bundler.
  // Alchemy stays reserved for the enhanced balance/transfer APIs that power
  // the holders + history views (it doesn't touch this path).
  return createPublicClient({
    chain,
    transport: http(bundlerReadRpcUrl(chainId)),
  });
}

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };

function bundlerRoot(): string {
  return requireEnv("CITIZENPAY_BUNDLER_URL").replace(/\/$/, "");
}

// Sponsor/submit methods are scoped to a paymaster (it's bound into the URL).
function bundlerRpcUrl(chainId: number, paymaster: string): string {
  return `${bundlerRoot()}/v1/${chainId}/rpc/${paymaster}`;
}

// Plain chain reads (eth_*) don't need a paymaster — the node answers them at
// the chain-scoped endpoint.
function bundlerReadRpcUrl(chainId: number): string {
  return `${bundlerRoot()}/v1/${chainId}/rpc`;
}

async function bundlerRpcAt<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new UserOpError(
      "submit_failed",
      `Bundler ${method} HTTP ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as RpcResponse<T>;
  if (body.error) {
    throw new UserOpError(
      method === "pm_ooSponsorUserOperation" ? "sponsor_failed" : "submit_failed",
      `Bundler ${method}: ${body.error.message}`,
    );
  }
  if (body.result === undefined) {
    throw new UserOpError(
      "submit_failed",
      `Bundler ${method} returned no result`,
    );
  }
  return body.result;
}

async function bundlerRpc<T>(
  chainId: number,
  paymaster: string,
  method: string,
  params: unknown[],
): Promise<T> {
  return bundlerRpcAt<T>(bundlerRpcUrl(chainId, paymaster), method, params);
}

// =============================================================================
// UserOp flow
// =============================================================================

async function prepareUserOp(args: {
  client: PublicClient;
  chainId: number;
  owner: Address;
  sender: Address;
  factory: Address;
  saltNonce?: bigint;
  callData: Hex;
}): Promise<UserOp> {
  const deployed = await senderAccountExists(
    args.client,
    args.chainId,
    args.sender,
  );
  const initCode: Hex = deployed
    ? "0x"
    : initCodeFor(args.factory, args.owner, args.saltNonce ?? SALT_NONCE);
  return {
    sender: args.sender,
    nonce: BigInt(0),
    initCode,
    callData: args.callData,
    callGasLimit: BigInt(0),
    verificationGasLimit: BigInt(0),
    preVerificationGas: BigInt(0),
    maxFeePerGas: BigInt(0),
    maxPriorityFeePerGas: BigInt(0),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

async function paymasterSignUserOp(args: {
  chainId: number;
  entrypoint: string;
  paymaster: string;
  paymasterType: string;
  op: UserOp;
}): Promise<UserOp> {
  const result = await bundlerRpc<[JsonUserOp]>(
    args.chainId,
    args.paymaster,
    "pm_ooSponsorUserOperation",
    [userOpToJson(args.op), args.entrypoint, { type: args.paymasterType }, 1],
  );
  const [sponsored] = result;
  if (!sponsored) {
    throw new UserOpError(
      "sponsor_failed",
      "pm_ooSponsorUserOperation returned an empty result",
    );
  }
  return userOpFromJson(sponsored);
}

async function signUserOp(args: {
  client: PublicClient;
  entrypoint: Address;
  op: UserOp;
  privateKey: Hex;
}): Promise<UserOp> {
  const hash = (await args.client.readContract({
    address: args.entrypoint,
    abi: ENTRYPOINT_ABI,
    functionName: "getUserOpHash",
    args: [args.op],
  })) as Hex;

  // EIP-191 personal_sign over the raw hash bytes (NOT EIP-712).
  const account = privateKeyToAccount(args.privateKey);
  const signature = await account.signMessage({ message: { raw: hash } });
  return { ...args.op, signature };
}

async function submitUserOp(args: {
  chainId: number;
  paymaster: string;
  entrypoint: string;
  op: UserOp;
  userOpData?: unknown;
  extraData?: unknown;
}): Promise<Hex> {
  const params: unknown[] = [userOpToJson(args.op), args.entrypoint];
  if (args.userOpData !== undefined) params.push(args.userOpData);
  if (args.extraData !== undefined) params.push(args.extraData);
  return await bundlerRpc<Hex>(
    args.chainId,
    args.paymaster,
    "eth_sendUserOperation",
    params,
  );
}

type UserOpStatus = {
  user_op_hash: Hex;
  tx_hash: Hex | null;
  status: "pending" | "submitted" | "success" | "reverted" | "timeout";
};

/**
 * Poll `pm_getUserOpTxHash` on the bundler until the userop reaches a
 * terminal state, then return the on-chain tx hash. The bundler stores
 * the userop in `pending`, broadcasts it (→ `submitted`, `tx_hash` set),
 * and resolves to `success` once the receipt confirms — or `reverted` /
 * `timeout` if it doesn't.
 *
 * We poll the bundler instead of `eth_getTransactionReceipt` because the
 * tx hash isn't known until the bundler broadcasts; passing the userop
 * hash to a normal chain RPC just spins until that RPC's own timeout.
 */
async function awaitUserOpSuccess(args: {
  chainId: number;
  paymaster: string;
  userOpHash: Hex;
}): Promise<Hex> {
  const deadline = Date.now() + USEROP_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await bundlerRpc<UserOpStatus>(
      args.chainId,
      args.paymaster,
      "pm_getUserOpTxHash",
      [args.userOpHash],
    );
    if (status.status === "success") {
      if (!status.tx_hash) {
        throw new UserOpError(
          "tx_failed",
          `UserOp ${args.userOpHash} reported success without a tx hash`,
        );
      }
      return status.tx_hash;
    }
    if (status.status === "reverted" || status.status === "timeout") {
      throw new UserOpError(
        "tx_failed",
        `UserOp ${args.userOpHash} status=${status.status}` +
          (status.tx_hash ? ` (tx ${status.tx_hash})` : ""),
      );
    }
    await new Promise((r) => setTimeout(r, USEROP_POLL_INTERVAL_MS));
  }
  throw new UserOpError(
    "tx_failed",
    `UserOp ${args.userOpHash} did not confirm within ${USEROP_POLL_TIMEOUT_MS}ms`,
  );
}

type EthReceipt = { status?: string; blockNumber?: string } | null;

/**
 * Fetch a plain on-chain receipt via the bundler URL (which is a full
 * JSON-RPC node — `eth_getTransactionReceipt` is supported there, and even
 * resolves userOp hashes to their settlement tx). This is a chain read, so
 * it hits the chain-scoped endpoint and needs no paymaster. Returns null
 * when the tx isn't mined / isn't known to the node, and never throws.
 */
export type UserOpResolution = {
  txHash: Hex | null;
  status: "pending" | "submitted" | "success" | "reverted" | "timeout";
};

/**
 * Resolve a userOp hash to its settlement tx hash + status via the bundler's
 * REST endpoint `GET /v1/{chainId}/userop/{hash}/tx`. A single non-blocking
 * poll — used by the annotation-resolve queue (services/transaction-annotation)
 * to turn the userOp hashes CP returns into the real on-chain tx hashes that
 * history is keyed by. A 404 (hash not yet known to the bundler) is reported as
 * `pending` so the caller retries; other transport errors throw.
 */
export async function getUserOpTx(
  chainId: number,
  userOpHash: string,
): Promise<UserOpResolution> {
  const res = await fetch(
    `${bundlerRoot()}/v1/${chainId}/userop/${userOpHash}/tx`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (res.status === 404) return { txHash: null, status: "pending" };
  if (!res.ok) {
    throw new UserOpError(
      "submit_failed",
      `Bundler userop/tx HTTP ${res.status}`,
    );
  }
  // The bundler wraps the payload in an envelope:
  //   { response_type: "object", object: { status, tx_hash, user_op_hash } }
  // Read from `object`, tolerating a flat shape in case a deployment returns it
  // un-wrapped. Reading the top level directly leaves status/txHash undefined,
  // so a settled userOp is never recognised as `success` and its annotation
  // churns until the attempt cap drops it (see processPendingAnnotations).
  const body = (await res.json()) as {
    object?: { tx_hash?: string | null; status?: UserOpResolution["status"] };
    tx_hash?: string | null;
    status?: UserOpResolution["status"];
  };
  const payload = body.object ?? body;
  return {
    txHash: (payload.tx_hash as Hex) ?? null,
    status: payload.status ?? "pending",
  };
}

export async function getBundlerTxReceipt(args: {
  chainId: number;
  txHash: string;
}): Promise<{ status: "success" | "reverted"; blockNumber: number | null } | null> {
  try {
    const r = await bundlerRpcAt<EthReceipt>(
      bundlerReadRpcUrl(args.chainId),
      "eth_getTransactionReceipt",
      [args.txHash],
    );
    if (!r) return null; // not mined / unknown to the node
    return {
      status: r.status === "0x1" ? "success" : "reverted",
      blockNumber: r.blockNumber ? Number.parseInt(r.blockNumber, 16) : null,
    };
  } catch (e) {
    console.warn("[receipts] eth_getTransactionReceipt failed", {
      hash: args.txHash,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// =============================================================================
// Public API
// =============================================================================

type FundContext = {
  fund: FundMinterContext;
  privateKey: Hex;
  owner: Address;
  sender: Address;
  token: Address;
  factory: Address;
  entrypoint: Address;
  paymaster: Address;
  paymasterType: string;
  client: PublicClient;
};

function loadFundContext(fund: FundMinterContext): FundContext {
  if (
    !fund.tokenMinterPrivateKeyEnc ||
    !fund.tokenMinterEoaAddress ||
    !fund.tokenMinterSmartAccountAddress
  ) {
    throw new UserOpError(
      "fund_not_provisioned",
      `Fund ${fund.id} has no minter wallet provisioned`,
    );
  }
  if (!fund.tokenAddress || !isAddress(fund.tokenAddress)) {
    throw new UserOpError(
      "no_token",
      `Fund ${fund.id} has no token address configured`,
    );
  }
  if (
    !fund.citizenPayEntrypointAddress ||
    !fund.citizenPayAccountFactoryAddress ||
    !fund.citizenPayPaymasterAddress ||
    !fund.citizenPayPaymasterType
  ) {
    throw new UserOpError(
      "fund_not_provisioned",
      `Fund ${fund.id} is missing 4337 stack identity — reconnect to Citizen Pay`,
    );
  }
  const privateKey = decryptSecret(fund.tokenMinterPrivateKeyEnc) as Hex;
  return {
    fund,
    privateKey,
    owner: fund.tokenMinterEoaAddress as Address,
    sender: fund.tokenMinterSmartAccountAddress as Address,
    token: fund.tokenAddress as Address,
    factory: fund.citizenPayAccountFactoryAddress as Address,
    entrypoint: fund.citizenPayEntrypointAddress as Address,
    paymaster: fund.citizenPayPaymasterAddress as Address,
    paymasterType: fund.citizenPayPaymasterType,
    client: publicClientFor(fund.tokenChainId),
  };
}

async function runUserOp(
  ctx: FundContext,
  callData: Hex,
  opts: {
    // Override the UserOp sender / salt to act from a non-minter account
    // (a named fund account). Defaults to the minter's own salt-0 Safe.
    sender?: Address;
    saltNonce?: bigint;
    userOpData?: unknown;
    extraData?: unknown;
  } = {},
): Promise<{ txHash: Hex; userOpHash: Hex }> {
  const chainId = ctx.fund.tokenChainId;
  const prepared = await prepareUserOp({
    client: ctx.client,
    chainId,
    owner: ctx.owner,
    sender: opts.sender ?? ctx.sender,
    factory: ctx.factory,
    saltNonce: opts.saltNonce ?? SALT_NONCE,
    callData,
  });
  const sponsored = await paymasterSignUserOp({
    chainId,
    entrypoint: ctx.entrypoint,
    paymaster: ctx.paymaster,
    paymasterType: ctx.paymasterType,
    op: prepared,
  });
  const signed = await signUserOp({
    client: ctx.client,
    entrypoint: ctx.entrypoint,
    op: sponsored,
    privateKey: ctx.privateKey,
  });
  // `eth_sendUserOperation` returns the userop hash (the engine queues
  // on-chain submission asynchronously). We then poll the bundler for
  // the actual tx hash + terminal status.
  const userOpHash = await submitUserOp({
    chainId,
    paymaster: ctx.paymaster,
    entrypoint: ctx.entrypoint,
    op: signed,
    userOpData: opts.userOpData,
    extraData: opts.extraData,
  });
  const txHash = await awaitUserOpSuccess({
    chainId,
    paymaster: ctx.paymaster,
    userOpHash,
  });
  return { txHash, userOpHash };
}

/**
 * Generic Safe-account call. Wrap `data` in `execTransactionFromModule` and
 * push it through the bundler. Use this for arbitrary contract calls; the
 * mint/burn helpers below are thin wrappers over it.
 */
export async function call(args: {
  fund: FundMinterContext;
  to: Address;
  value?: bigint;
  data: Hex;
  userOpData?: unknown;
  extraData?: unknown;
}): Promise<{ txHash: Hex; userOpHash: Hex }> {
  const ctx = loadFundContext(args.fund);
  const callData = executeSafeCallData(
    args.to,
    args.value ?? BigInt(0),
    args.data,
  );
  return await runUserOp(ctx, callData, {
    userOpData: args.userOpData,
    extraData: args.extraData,
  });
}

export async function mintToken(args: {
  fund: FundMinterContext;
  to: Address;
  amount: bigint;
  userOpData?: unknown;
  extraData?: unknown;
}): Promise<{ txHash: Hex; userOpHash: Hex }> {
  const ctx = loadFundContext(args.fund);
  const callData = safeMintCallData(ctx.token, args.to, args.amount);
  try {
    return await runUserOp(ctx, callData, {
      userOpData: args.userOpData,
      extraData: args.extraData,
    });
  } catch (e) {
    if (e instanceof UserOpError && e.code === "submit_failed") {
      await assertMinterRole(ctx);
    }
    throw e;
  }
}

export async function burnFromToken(args: {
  fund: FundMinterContext;
  from: Address;
  amount: bigint;
  userOpData?: unknown;
  extraData?: unknown;
}): Promise<{ txHash: Hex; userOpHash: Hex }> {
  const ctx = loadFundContext(args.fund);
  const callData = safeBurnFromCallData(ctx.token, args.from, args.amount);
  try {
    return await runUserOp(ctx, callData, {
      userOpData: args.userOpData,
      extraData: args.extraData,
    });
  } catch (e) {
    if (e instanceof UserOpError && e.code === "submit_failed") {
      await assertBurnerRole(ctx);
    }
    throw e;
  }
}

/**
 * Transfer the fund token FROM one of the fund's named accounts (a Safe
 * derived from the minter EOA at `saltNonce`) to `to`. The minter EOA owns
 * every such Safe, so the same key signs the userop; the account is lazily
 * deployed via the salt-specific initCode on its first outbound op. This is a
 * plain ERC20 `transfer` — no mint/burn role required. `sender` is the
 * account's cached counterfactual address (FundTokenAccount.address).
 */
export async function transferFromAccount(args: {
  fund: FundMinterContext;
  saltNonce: bigint;
  sender: Address;
  to: Address;
  amount: bigint;
  userOpData?: unknown;
  extraData?: unknown;
}): Promise<{ txHash: Hex; userOpHash: Hex }> {
  const ctx = loadFundContext(args.fund);
  const callData = safeTransferCallData(ctx.token, args.to, args.amount);
  return await runUserOp(ctx, callData, {
    sender: args.sender,
    saltNonce: args.saltNonce,
    userOpData: args.userOpData,
    extraData: args.extraData,
  });
}

/**
 * Convenience for the ERC20 token Transfer event topic — call sites passing
 * `userOpData` for analytics use this so the bundler can index by topic.
 */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

// =============================================================================
// Role checks (post-failure diagnostics)
// =============================================================================

async function assertMinterRole(ctx: FundContext): Promise<void> {
  const role = (await ctx.client.readContract({
    address: ctx.token,
    abi: ERC20_ABI,
    functionName: "MINTER_ROLE",
  })) as Hex;
  const has = (await ctx.client.readContract({
    address: ctx.token,
    abi: ERC20_ABI,
    functionName: "hasRole",
    args: [role, ctx.sender],
  })) as boolean;
  if (!has) {
    throw new UserOpError(
      "missing_role",
      `Smart account ${ctx.sender} is missing MINTER_ROLE on ${ctx.token}`,
    );
  }
}

async function assertBurnerRole(ctx: FundContext): Promise<void> {
  const role = (await ctx.client.readContract({
    address: ctx.token,
    abi: ERC20_ABI,
    functionName: "BURNER_ROLE",
  })) as Hex;
  const has = (await ctx.client.readContract({
    address: ctx.token,
    abi: ERC20_ABI,
    functionName: "hasRole",
    args: [role, ctx.sender],
  })) as boolean;
  if (!has) {
    throw new UserOpError(
      "missing_role",
      `Smart account ${ctx.sender} is missing BURNER_ROLE on ${ctx.token}`,
    );
  }
}

// Re-export the hex helper for tests / debugging.
export const __test = { toQuantity };
