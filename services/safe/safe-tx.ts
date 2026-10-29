// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure Safe 1.4.1 helpers: SafeTx construction, the EIP-712 safeTxHash,
// signature packing + recovery, owner-management / ERC-20 calldata, and the
// CREATE2 address a SafeProxyFactory deployment lands on. No env, no fetch,
// no server-only — isomorphic and fully unit-tested (safe-tx.test.ts).
// Module map: services/safe/config.ts.

import {
  bytesToBigInt,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  hashTypedData,
  keccak256,
  recoverMessageAddress,
  recoverTypedDataAddress,
  size,
  slice,
  toHex,
  hexToNumber,
} from "viem";

import { ERC20_ABI, SAFE_ABI } from "@/services/safe/abi";
import { SafeError, type Address, type Hex, type SafeTx } from "@/services/safe/types";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
// Head of the Safe's owners linked list (OwnerManager.SENTINEL_OWNERS).
export const SENTINEL_OWNERS: Address = "0x0000000000000000000000000000000000000001";

// ---------------------------------------------------------------------------
// SafeTx + EIP-712
// ---------------------------------------------------------------------------

export function buildSafeTx(a: {
  to: Address;
  value?: bigint;
  data?: Hex;
  nonce: bigint;
  operation?: 0 | 1;
}): SafeTx {
  return {
    to: getAddress(a.to),
    value: a.value ?? BigInt(0),
    data: a.data ?? "0x",
    operation: a.operation ?? 0,
    // Relayer pays gas, no refund: gas fields zero, gasToken/refundReceiver 0x0.
    safeTxGas: BigInt(0),
    baseGas: BigInt(0),
    gasPrice: BigInt(0),
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: a.nonce,
  };
}

// Field order is load-bearing: it must match Safe's SAFE_TX_TYPEHASH
// keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,
// uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,
// address refundReceiver,uint256 nonce)").
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/**
 * The viem `signTypedData` / `hashTypedData` parameters for a SafeTx. Safe
 * 1.3+ uses the domain `EIP712Domain(uint256 chainId,address verifyingContract)`
 * — no name/version — which viem derives from the fields present.
 */
export function safeTxTypedData(a: { chainId: number; safeAddress: Address; tx: SafeTx }) {
  return {
    domain: { chainId: a.chainId, verifyingContract: getAddress(a.safeAddress) },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: {
      to: a.tx.to,
      value: a.tx.value,
      data: a.tx.data,
      operation: a.tx.operation,
      safeTxGas: a.tx.safeTxGas,
      baseGas: a.tx.baseGas,
      gasPrice: a.tx.gasPrice,
      gasToken: a.tx.gasToken,
      refundReceiver: a.tx.refundReceiver,
      nonce: a.tx.nonce,
    },
  };
}

export function safeTxHash(a: { chainId: number; safeAddress: Address; tx: SafeTx }): Hex {
  return hashTypedData(safeTxTypedData(a));
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Concatenate owner signatures in the order Safe.checkNSignatures requires
 * (owner addresses strictly ascending). Only 65-byte ECDSA signatures (v 27/28
 * or eth_sign-style 31/32) are supported.
 */
// Case-insensitive address helpers shared by proposals / sync / UI loaders.
export const lc = (a: string): string => a.toLowerCase();
export const sameAddress = (a: string, b: string): boolean => lc(a) === lc(b);

// Rebuild the SafeTx from a stored FundSafeTransaction row (gas fields are
// always zero for our transactions).
export function safeTxFromRow(row: {
  to: string;
  value: string;
  data: string;
  operation: number;
  nonce: number;
}): SafeTx {
  return buildSafeTx({
    to: row.to as Address,
    value: BigInt(row.value),
    data: row.data as Hex,
    nonce: BigInt(row.nonce),
    operation: row.operation === 1 ? 1 : 0,
  });
}

export function packSignatures(sigs: { owner: Address; signature: Hex }[]): Hex {
  const seen = new Set<string>();
  for (const s of sigs) {
    const owner = s.owner.toLowerCase();
    if (seen.has(owner)) {
      throw new SafeError("invalid_signature", `Duplicate signature for owner ${s.owner}`);
    }
    seen.add(owner);
    if (!/^0x[0-9a-fA-F]*$/.test(s.signature) || size(s.signature) !== 65) {
      throw new SafeError(
        "invalid_signature",
        `Signature for owner ${s.owner} is not 65 bytes`,
      );
    }
  }
  const sorted = [...sigs].sort((x, y) => {
    const a = x.owner.toLowerCase();
    const b = y.owner.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (sorted.length === 0) return "0x";
  return concat(sorted.map((s) => s.signature));
}

/**
 * Recover the owner that produced `signature` over the SafeTx.
 *   v 27/28 → EIP-712 signature over the typed data (what our signer and
 *             Safe{Wallet} with eth_signTypedData produce).
 *   v 31/32 → eth_sign over the raw safeTxHash, v bumped by 4 (Safe's marker).
 * Contract signatures (v 0) and approved hashes (v 1) are rejected.
 */
export async function recoverSafeTxSigner(a: {
  chainId: number;
  safeAddress: Address;
  tx: SafeTx;
  signature: Hex;
}): Promise<Address> {
  if (!/^0x[0-9a-fA-F]*$/.test(a.signature) || size(a.signature) !== 65) {
    throw new SafeError("invalid_signature", "Signature is not 65 bytes");
  }
  const v = hexToNumber(slice(a.signature, 64, 65));
  try {
    if (v === 27 || v === 28) {
      const signer = await recoverTypedDataAddress({
        ...safeTxTypedData(a),
        signature: a.signature,
      });
      return getAddress(signer);
    }
    if (v === 31 || v === 32) {
      const adjusted = concat([slice(a.signature, 0, 64), toHex(v - 4, { size: 1 })]);
      const signer = await recoverMessageAddress({
        message: { raw: safeTxHash(a) },
        signature: adjusted,
      });
      return getAddress(signer);
    }
  } catch (e) {
    throw new SafeError("invalid_signature", "Signature could not be recovered", {
      cause: e,
    });
  }
  throw new SafeError("invalid_signature", `Unsupported signature type (v=${v})`);
}

// ---------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------

export function erc20TransferData(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [getAddress(to), amount],
  });
}

export function addOwnerWithThresholdData(owner: Address, threshold: bigint): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "addOwnerWithThreshold",
    args: [getAddress(owner), threshold],
  });
}

// The owners list is a linked list; removeOwner/swapOwner take the entry that
// points at the target. `currentOwners` must be in getOwners() order.
function prevOwnerOf(currentOwners: Address[], owner: Address): Address {
  const target = owner.toLowerCase();
  const idx = currentOwners.findIndex((o) => o.toLowerCase() === target);
  if (idx === -1) {
    throw new SafeError("not_owner", `${owner} is not an owner of this Safe`);
  }
  return idx === 0 ? SENTINEL_OWNERS : getAddress(currentOwners[idx - 1]);
}

export function removeOwnerData(
  currentOwners: Address[],
  owner: Address,
  threshold: bigint,
): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "removeOwner",
    args: [prevOwnerOf(currentOwners, owner), getAddress(owner), threshold],
  });
}

export function swapOwnerData(
  currentOwners: Address[],
  oldOwner: Address,
  newOwner: Address,
): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "swapOwner",
    args: [prevOwnerOf(currentOwners, oldOwner), getAddress(oldOwner), getAddress(newOwner)],
  });
}

export function changeThresholdData(threshold: bigint): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "changeThreshold",
    args: [threshold],
  });
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/** Safe.setup initializer: no module setup call, no deployment refund. */
export function safeSetupData(a: {
  owners: Address[];
  threshold: bigint;
  fallbackHandler: Address;
}): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [
      a.owners.map((o) => getAddress(o)),
      a.threshold,
      ZERO_ADDRESS,
      "0x",
      getAddress(a.fallbackHandler),
      ZERO_ADDRESS,
      BigInt(0),
      ZERO_ADDRESS,
    ],
  });
}

/**
 * Address SafeProxyFactory 1.4.1 `createProxyWithNonce` deploys to:
 *   salt         = keccak256(keccak256(initializer) ‖ uint256(saltNonce))
 *   initCodeHash = keccak256(proxyCreationCode ‖ abi.encode(singleton))
 *   CREATE2 from the factory.
 */
export function predictSafeAddress(a: {
  proxyFactory: Address;
  singleton: Address;
  initializer: Hex;
  saltNonce: bigint;
  proxyCreationCode: Hex;
}): Address {
  const salt = keccak256(concat([keccak256(a.initializer), toHex(a.saltNonce, { size: 32 })]));
  const bytecodeHash = keccak256(
    concat([
      a.proxyCreationCode,
      encodeAbiParameters([{ type: "address" }], [getAddress(a.singleton)]),
    ]),
  );
  return getContractAddress({
    opcode: "CREATE2",
    from: getAddress(a.proxyFactory),
    salt,
    bytecodeHash,
  });
}

/** Crypto-random uint256 for createProxyWithNonce (WebCrypto: node + browser). */
export function randomSaltNonce(): bigint {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBigInt(bytes);
}

/** Owners added / removed between two owner lists (case-insensitive). */
export function summarizeOwnerDiff(
  before: Address[],
  after: Address[],
): { added: Address[]; removed: Address[] } {
  const b = new Set(before.map((o) => o.toLowerCase()));
  const a = new Set(after.map((o) => o.toLowerCase()));
  return {
    added: after.filter((o) => !b.has(o.toLowerCase())).map((o) => getAddress(o)),
    removed: before.filter((o) => !a.has(o.toLowerCase())).map((o) => getAddress(o)),
  };
}
