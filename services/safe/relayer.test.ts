// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  hexToBigInt,
  toHex,
  type Log,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  publicClient: {
    getCode: vi.fn(),
    readContract: vi.fn(),
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getBalance: vi.fn(),
    getBlockNumber: vi.fn(),
    request: vi.fn(),
  },
  walletClient: {
    account: { address: "0x0000000000000000000000000000000000000abc" },
    writeContract: vi.fn(),
  },
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => mocks.publicClient),
    createWalletClient: vi.fn(() => mocks.walletClient),
  };
});

import { SAFE_ABI } from "@/services/safe/abi";
import {
  EXECUTION_SCAN_CHUNK_BLOCKS,
  deploySafe,
  errorTxHash,
  execSafeTransaction,
  findSafeExecution,
  isRelayerConfigured,
  mapSimulationError,
  readSafeState,
  relayerAddress,
  simulateSafeTransaction,
} from "@/services/safe/relayer";
import { buildSafeTx } from "@/services/safe/safe-tx";
import { SafeError, type Address, type Hex } from "@/services/safe/types";

// Hardhat's well-known test account #0 key (public, never funded on Gnosis).
const TEST_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SAFE: Address = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0";
const TX_HASH = `0x${"11".repeat(32)}` as Hex;
const SIGS = `0x${"cd".repeat(64)}1b` as Hex;
const tx = buildSafeTx({ to: TEST_ADDR, nonce: BigInt(0) });

function revertError(reason: string) {
  const data = encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
    errorName: "Error",
    args: [reason],
  });
  const cause = new ContractFunctionRevertedError({
    abi: SAFE_ABI,
    data,
    functionName: "execTransaction",
  });
  return new ContractFunctionExecutionError(cause, {
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [tx.to, tx.value, tx.data, tx.operation, BigInt(0), BigInt(0), BigInt(0), tx.gasToken, tx.refundReceiver, SIGS],
    contractAddress: SAFE,
  });
}

function executionLog(eventName: "ExecutionSuccess" | "ExecutionFailure", address: Address): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: SAFE_ABI, eventName, args: { txHash: TX_HASH } }) as [
      Hex,
      ...Hex[],
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [BigInt(0)]),
    blockHash: TX_HASH,
    blockNumber: BigInt(1),
    logIndex: 0,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    removed: false,
  };
}

beforeEach(() => {
  vi.stubEnv("SAFE_RELAYER_PRIVATE_KEY", TEST_KEY);
  vi.stubEnv("ALCHEMY_API_KEY", "test");
  for (const fn of Object.values(mocks.publicClient)) fn.mockReset();
  mocks.walletClient.writeContract.mockReset();
  mocks.publicClient.simulateContract.mockResolvedValue({ result: true });
  mocks.publicClient.estimateContractGas.mockResolvedValue(BigInt(100_000));
  mocks.walletClient.writeContract.mockResolvedValue(TX_HASH);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("relayer config", () => {
  it("accepts a 32-byte key with or without 0x", () => {
    expect(isRelayerConfigured()).toBe(true);
    expect(relayerAddress()).toBe(TEST_ADDR);
    vi.stubEnv("SAFE_RELAYER_PRIVATE_KEY", `0x${TEST_KEY}`);
    expect(relayerAddress()).toBe(TEST_ADDR);
  });

  it("rejects missing or malformed keys", async () => {
    vi.stubEnv("SAFE_RELAYER_PRIVATE_KEY", "");
    expect(isRelayerConfigured()).toBe(false);
    expect(relayerAddress()).toBeNull();
    vi.stubEnv("SAFE_RELAYER_PRIVATE_KEY", "0x1234");
    expect(isRelayerConfigured()).toBe(false);
    await expect(
      simulateSafeTransaction({ chainId: 100, safeAddress: SAFE, tx, signatures: SIGS }),
    ).rejects.toMatchObject({ code: "relayer_not_configured" });
  });

  it("needs ALCHEMY_API_KEY and a supported chain", async () => {
    await expect(readSafeState({ chainId: 1, safeAddress: SAFE })).rejects.toMatchObject({
      code: "unsupported_chain",
    });
    vi.stubEnv("ALCHEMY_API_KEY", "");
    await expect(readSafeState({ chainId: 100, safeAddress: SAFE })).rejects.toMatchObject({
      code: "config",
    });
  });
});

describe("errorTxHash", () => {
  it("reads an attached hash, ignores anything else", () => {
    expect(errorTxHash(Object.assign(new SafeError("tx_reverted", "x"), { txHash: TX_HASH }))).toBe(
      TX_HASH,
    );
    expect(errorTxHash(new SafeError("tx_reverted", "x"))).toBeNull();
    expect(errorTxHash({ txHash: "0x12" })).toBeNull();
    expect(errorTxHash(null)).toBeNull();
  });
});

describe("mapSimulationError", () => {
  it("decodes Safe GS reasons into tx_reverted", () => {
    const err = mapSimulationError(revertError("GS026"));
    expect(err.code).toBe("tx_reverted");
    expect(err.message).toMatch(/^GS026: invalid owner/);
  });

  it("maps transport errors to relayer_failed", () => {
    expect(mapSimulationError(new Error("socket hang up")).code).toBe("relayer_failed");
  });
});

describe("readSafeState", () => {
  it("reports an undeployed Safe without reading it", async () => {
    mocks.publicClient.getCode.mockResolvedValue(undefined);
    await expect(readSafeState({ chainId: 100, safeAddress: SAFE })).resolves.toEqual({
      deployed: false,
      owners: [],
      threshold: 0,
      nonce: 0,
    });
    expect(mocks.publicClient.readContract).not.toHaveBeenCalled();
  });

  it("reads owners, threshold and nonce", async () => {
    mocks.publicClient.getCode.mockResolvedValue("0x6080");
    mocks.publicClient.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === "getOwners") return [TEST_ADDR.toLowerCase()];
      if (functionName === "getThreshold") return BigInt(1);
      return BigInt(4);
    });
    await expect(readSafeState({ chainId: 100, safeAddress: SAFE })).resolves.toEqual({
      deployed: true,
      owners: [TEST_ADDR],
      threshold: 1,
      nonce: 4,
    });
  });
});

describe("deploySafe", () => {
  it("returns the predicted address without sending when code already exists", async () => {
    mocks.publicClient.readContract.mockResolvedValue("0x6080");
    mocks.publicClient.getCode.mockResolvedValue("0x6080");
    const res = await deploySafe({
      chainId: 100,
      owners: [TEST_ADDR],
      threshold: 1,
      saltNonce: BigInt(1),
    });
    expect(res.txHash).toBe("0x");
    expect(res.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(mocks.walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("rejects an impossible threshold", async () => {
    await expect(
      deploySafe({ chainId: 100, owners: [TEST_ADDR], threshold: 2, saltNonce: BigInt(1) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("execSafeTransaction", () => {
  const args = { chainId: 100, safeAddress: SAFE, tx, signatures: SIGS };

  it("returns the hash on ExecutionSuccess, with a gas buffer", async () => {
    mocks.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [executionLog("ExecutionSuccess", SAFE)],
    });
    await expect(execSafeTransaction(args)).resolves.toEqual({ txHash: TX_HASH });
    expect(mocks.walletClient.writeContract.mock.calls[0][0].gas).toBe(BigInt(120_000));
  });

  it("does not send when simulation reverts", async () => {
    mocks.publicClient.simulateContract.mockRejectedValue(revertError("GS013"));
    await expect(execSafeTransaction(args)).rejects.toMatchObject({
      code: "tx_reverted",
      message: expect.stringContaining("GS013"),
    });
    expect(mocks.walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("treats ExecutionFailure as tx_reverted and attaches the hash", async () => {
    mocks.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [executionLog("ExecutionFailure", SAFE)],
    });
    const err = await execSafeTransaction(args).catch((e) => e);
    expect(err).toBeInstanceOf(SafeError);
    expect(err.code).toBe("tx_reverted");
    expect(err.message).toContain("inner call failed");
    expect(errorTxHash(err)).toBe(TX_HASH);
  });

  it("ignores ExecutionFailure logs from another contract", async () => {
    mocks.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [executionLog("ExecutionFailure", TEST_ADDR)],
    });
    await expect(execSafeTransaction(args)).resolves.toEqual({ txHash: TX_HASH });
  });

  it("maps a reverted receipt and a receipt timeout, both carrying the hash", async () => {
    mocks.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", logs: [] });
    const reverted = await execSafeTransaction(args).catch((e) => e);
    expect(reverted.code).toBe("tx_reverted");
    expect(errorTxHash(reverted)).toBe(TX_HASH);

    mocks.publicClient.waitForTransactionReceipt.mockRejectedValue(new Error("timed out"));
    const timeout = await execSafeTransaction(args).catch((e) => e);
    expect(timeout.code).toBe("relayer_failed");
    expect(errorTxHash(timeout)).toBe(TX_HASH);
  });
});

describe("findSafeExecution", () => {
  const args = { chainId: 100, safeAddress: SAFE, safeTxHash: TX_HASH };
  const latest = BigInt(50_000_000);
  const ONE = BigInt(1);

  function rawLog(eventName: "ExecutionSuccess" | "ExecutionFailure", blockNumber: bigint) {
    return {
      address: SAFE,
      topics: encodeEventTopics({ abi: SAFE_ABI, eventName, args: { txHash: TX_HASH } }),
      data: "0x",
      blockNumber: toHex(blockNumber),
      blockHash: TX_HASH,
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    };
  }

  function ranges() {
    return mocks.publicClient.request.mock.calls.map(([call]) => {
      const p = (call as { params: [{ fromBlock: Hex; toBlock: Hex; topics: unknown }] }).params[0];
      return { from: hexToBigInt(p.fromBlock), to: hexToBigInt(p.toBlock), topics: p.topics };
    });
  }

  it("walks the lookback newest-first in chunks the RPC accepts and stops at the first hit", async () => {
    mocks.publicClient.getBlockNumber.mockResolvedValue(latest);
    const hitBlock = latest - BigInt(12_000);
    mocks.publicClient.request
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rawLog("ExecutionSuccess", hitBlock)]);

    await expect(findSafeExecution(args)).resolves.toEqual({
      txHash: TX_HASH,
      success: true,
      blockNumber: hitBlock,
    });

    const calls = ranges();
    expect(calls).toHaveLength(2);
    expect(calls[0].to).toBe(latest);
    expect(calls[1].to).toBe(calls[0].from - ONE);
    for (const c of calls) {
      expect(c.to - c.from + ONE).toBeLessThanOrEqual(EXECUTION_SCAN_CHUNK_BLOCKS);
    }
    // One call carries both events for this safeTxHash.
    const [successTopic, hashTopic] = encodeEventTopics({
      abi: SAFE_ABI,
      eventName: "ExecutionSuccess",
      args: { txHash: TX_HASH },
    });
    const [failureTopic] = encodeEventTopics({ abi: SAFE_ABI, eventName: "ExecutionFailure" });
    expect(calls[0].topics).toEqual([[successTopic, failureTopic], hashTopic]);
  });

  it("reports a reverted inner call as an unsuccessful execution", async () => {
    mocks.publicClient.getBlockNumber.mockResolvedValue(latest);
    mocks.publicClient.request.mockResolvedValueOnce([rawLog("ExecutionFailure", latest - ONE)]);

    await expect(findSafeExecution(args)).resolves.toMatchObject({ success: false, txHash: TX_HASH });
  });

  it("returns null once the whole lookback window is scanned, and never scans below block 0", async () => {
    mocks.publicClient.getBlockNumber.mockResolvedValue(latest);
    mocks.publicClient.request.mockResolvedValue([]);

    await expect(findSafeExecution(args)).resolves.toBeNull();
    const calls = ranges();
    expect(calls).toHaveLength(12); // 120 000 / 10 000
    expect(calls[0].to).toBe(latest);
    expect(calls[11].from).toBe(latest - BigInt(120_000) + ONE);

    mocks.publicClient.request.mockClear();
    mocks.publicClient.getBlockNumber.mockResolvedValue(BigInt(15_000));
    await expect(findSafeExecution(args)).resolves.toBeNull();
    const young = ranges();
    expect(young).toHaveLength(2);
    expect(young[1].from).toBe(BigInt(0));
  });
});
