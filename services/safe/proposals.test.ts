// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Proposal / signature / execution flow of services/safe/proposals.ts against
// an in-memory Prisma (test-fake-prisma.ts). Chain (relayer), Safe Tx Service
// and signer keys are faked; safe-tx.ts (hashing, packing, calldata) is real.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", async () => ({
  prisma: (await import("./test-fake-prisma")).fake.prisma,
}));

const relayer = vi.hoisted(() => ({
  isRelayerConfigured: vi.fn(),
  readSafeState: vi.fn(),
  deploySafe: vi.fn(),
  execSafeTransaction: vi.fn(),
  errorTxHash: vi.fn((e: unknown) => (e as { txHash?: string }).txHash ?? null),
  findSafeExecution: vi.fn(),
}));
vi.mock("@/services/safe/relayer", () => relayer);

const txService = vi.hoisted(() => ({
  isTxServiceEnabled: vi.fn(),
  proposeTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  getMultisigTransaction: vi.fn(),
}));
vi.mock("@/services/safe/tx-service", () => txService);

const signer = vi.hoisted(() => ({
  getOrCreateFundSigner: vi.fn(),
  signSafeTxWithSigner: vi.fn(),
}));
vi.mock("@/services/safe/signer", () => signer);

const sync = vi.hoisted(() => ({ syncSafe: vi.fn() }));
vi.mock("@/services/safe/sync", () => sync);

const annotate = vi.hoisted(() => ({
  annotateTransaction: vi.fn(),
  ANNOTATION_KINDS: { safeTransfer: "SAFE_TRANSFER" },
  ANNOTATION_TRIGGERS: { safeTransfer: "SAFE_TRANSFER" },
}));
vi.mock("@/services/transaction-annotation/annotate", () => annotate);

import { fake, resetFake } from "./test-fake-prisma";
import {
  proposeOwnerChange,
  proposeRejection,
  proposeTokenTransfer,
  retryExecution,
  signTransaction,
  tryExecute,
} from "./proposals";
import { SafeError } from "./types";

const db = fake.db;
const SAFE = getAddress("0x5afe00000000000000000000000000000000cafe");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const RECIPIENT = getAddress("0x9999999999999999999999999999999999999999");
const A = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const B = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const C = getAddress("0xcccccccccccccccccccccccccccccccccccccccc");
const D = getAddress("0xdddddddddddddddddddddddddddddddddddddddd");
const EXEC_HASH = `0x${"e1".repeat(32)}` as const;
const FUND = { id: "fund-1", tokenChainId: 100, tokenAddress: TOKEN, tokenDecimals: 6 };

// 65-byte signature, distinct per key.
const sigFor = (enc: string) => `0x${enc.slice(-2).repeat(65)}` as `0x${string}`;

let safeId: string;

function seed(opts: { threshold: number; owners: { userId: string; address: string; byte: string }[]; chainNonce?: number }) {
  for (const o of opts.owners) {
    db.user.push({ id: o.userId, name: `User ${o.userId}`, email: `${o.userId}@x.test` });
    db.fundMember.push({ fundId: FUND.id, userId: o.userId, role: "ADMIN" });
    db.fundSigner.push({
      id: `signer-${o.userId}`,
      fundId: FUND.id,
      userId: o.userId,
      address: o.address,
      privateKeyEnc: `enc-${o.byte}`,
    });
  }
  safeId = "safe-1";
  db.fundSafe.push({
    id: safeId,
    fundId: FUND.id,
    name: "Treasury",
    chainId: 100,
    saltNonce: "1",
    address: SAFE,
    threshold: opts.threshold,
    status: "ACTIVE",
    archivedAt: null,
    lastSyncedAt: null,
  });
  for (const o of opts.owners) {
    db.fundSafeOwner.push({
      id: `owner-${o.userId}`,
      safeId,
      address: o.address,
      kind: "MEMBER",
      signerId: `signer-${o.userId}`,
      label: null,
      removedAt: null,
    });
  }
  relayer.readSafeState.mockResolvedValue({
    deployed: true,
    owners: opts.owners.map((o) => o.address),
    threshold: opts.threshold,
    nonce: opts.chainNonce ?? 0,
  });
}

const OWNERS_3 = [
  { userId: "u-a", address: A, byte: "1a" },
  { userId: "u-b", address: B, byte: "1b" },
  { userId: "u-c", address: C, byte: "1c" },
];

function transfer(userId: string, amount = "12.5") {
  return proposeTokenTransfer({
    fund: FUND,
    safeId,
    userId,
    input: { safeId, recipient: RECIPIENT, amount, recipientLabel: "Bakery" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFake();
  relayer.isRelayerConfigured.mockReturnValue(true);
  relayer.execSafeTransaction.mockResolvedValue({ txHash: EXEC_HASH });
  txService.isTxServiceEnabled.mockReturnValue(false);
  signer.signSafeTxWithSigner.mockImplementation(async (s: { privateKeyEnc: string }) => sigFor(s.privateKeyEnc));
  signer.getOrCreateFundSigner.mockImplementation(async (fundId: string, userId: string) => {
    const s = db.fundSigner.find((x) => x.fundId === fundId && x.userId === userId);
    if (!s) throw new Error("no signer in test");
    return s;
  });
  sync.syncSafe.mockResolvedValue({ synced: true });
});

describe("proposeTokenTransfer", () => {
  it("executes immediately on a 1-of-1 Safe and records the TokenOperation", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });

    const res = await transfer("u-a");

    expect(res).toMatchObject({ executed: true, txHash: EXEC_HASH });
    expect(relayer.execSafeTransaction).toHaveBeenCalledTimes(1);
    expect(relayer.execSafeTransaction.mock.calls[0][0].signatures).toBe(sigFor("enc-1a"));

    const tx = db.fundSafeTransaction[0];
    expect(tx).toMatchObject({
      status: "EXECUTED",
      executedBy: "relayer",
      txHash: EXEC_HASH,
      kind: "TOKEN_TRANSFER",
      to: TOKEN,
      nonce: 0,
    });
    expect(tx.summary).toEqual({
      kind: "TOKEN_TRANSFER",
      amount: "12.5",
      recipient: RECIPIENT,
      recipientLabel: "Bakery",
    });
    expect(db.tokenOperation).toHaveLength(1);
    expect(db.tokenOperation[0]).toMatchObject({
      fundId: FUND.id,
      type: "TRANSFER",
      account: RECIPIENT,
      amount: "12.5",
      status: "CONFIRMED",
      txHash: EXEC_HASH,
    });
    expect(tx.tokenOperationId).toBe(db.tokenOperation[0].id);
    expect(annotate.annotateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fundId: FUND.id, txHash: EXEC_HASH, trigger: "SAFE_TRANSFER", triggeredByUserId: "u-a" }),
    );
  });

  it("2-of-3: stays PENDING after the proposal, executes on the second signature", async () => {
    seed({ threshold: 2, owners: OWNERS_3 });

    const proposed = await transfer("u-c");
    expect(proposed).toMatchObject({ executed: false, txHash: null });
    expect(db.fundSafeTransaction[0].status).toBe("PENDING");
    expect(db.fundSafeSignature).toHaveLength(1);
    expect(relayer.execSafeTransaction).not.toHaveBeenCalled();

    const signed = await signTransaction({ fundId: FUND.id, transactionId: proposed.transactionId, userId: "u-a" });
    expect(signed).toEqual({ executed: true, txHash: EXEC_HASH });
    // Packed in ascending owner order: A before C.
    const packed = relayer.execSafeTransaction.mock.calls[0][0].signatures as string;
    expect(packed).toBe(`${sigFor("enc-1a")}${sigFor("enc-1c").slice(2)}`);
    expect(db.fundSafeTransaction[0].status).toBe("EXECUTED");
    expect(db.fundSafeSignature).toHaveLength(2);
  });

  it("queues the next proposal at the next nonce", async () => {
    seed({ threshold: 2, owners: OWNERS_3, chainNonce: 4 });
    await transfer("u-a", "1");
    await transfer("u-a", "2");
    expect(db.fundSafeTransaction.map((t) => t.nonce)).toEqual([4, 5]);
  });

  it("refuses a non-owner (no signer, or a signer that is not an owner)", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });
    db.fundSigner.push({ id: "signer-d", fundId: FUND.id, userId: "u-d", address: D, privateKeyEnc: "enc-1d" });

    await expect(transfer("u-d")).rejects.toMatchObject({ code: "not_owner" });
    await expect(transfer("u-nobody")).rejects.toMatchObject({ code: "not_owner" });
    expect(db.fundSafeTransaction).toHaveLength(0);
  });

  it("does not see another fund's Safe", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });
    await expect(
      proposeTokenTransfer({
        fund: { ...FUND, id: "fund-2" },
        safeId,
        userId: "u-a",
        input: { safeId, recipient: RECIPIENT, amount: "1" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("tx-service failures do not fail propose or sign", async () => {
    seed({ threshold: 2, owners: OWNERS_3 });
    txService.isTxServiceEnabled.mockReturnValue(true);
    txService.proposeTransaction.mockRejectedValue(new SafeError("tx_service", "down"));
    txService.confirmTransaction.mockRejectedValue(new SafeError("tx_service", "down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const proposed = await transfer("u-a");
    const signed = await signTransaction({ fundId: FUND.id, transactionId: proposed.transactionId, userId: "u-b" });

    expect(txService.proposeTransaction).toHaveBeenCalledTimes(1);
    expect(txService.confirmTransaction).toHaveBeenCalledTimes(1);
    expect(signed.executed).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("marks FAILED with the error on a revert, keeping signatures (retryable)", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });
    const revert = Object.assign(new SafeError("tx_reverted", "GS013"), { txHash: EXEC_HASH });
    relayer.execSafeTransaction.mockRejectedValueOnce(revert);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(transfer("u-a")).rejects.toMatchObject({ code: "tx_reverted" });

    const tx = db.fundSafeTransaction[0];
    expect(tx).toMatchObject({ status: "FAILED", errorMessage: "tx_reverted: GS013", txHash: EXEC_HASH });
    expect(db.fundSafeSignature).toHaveLength(1);
    expect(db.tokenOperation).toHaveLength(0);

    // Retry flips it back and executes.
    const retried = await retryExecution({ fundId: FUND.id, transactionId: tx.id as string });
    expect(retried).toEqual({ executed: true, txHash: EXEC_HASH });
    expect(tx.status).toBe("EXECUTED");
    err.mockRestore();
  });
});

describe("tryExecute failure handling", () => {
  it("hands a pre-broadcast relayer failure back to PENDING (nothing reached the chain)", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });
    relayer.execSafeTransaction.mockRejectedValueOnce(
      new SafeError("relayer_failed", "execTransaction not sent: nonce too low"),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(transfer("u-a")).rejects.toMatchObject({ code: "relayer_failed" });

    const tx = db.fundSafeTransaction[0];
    expect(tx.status).toBe("PENDING");
    expect(db.fundSafeSignature).toHaveLength(1);

    // The next attempt (cron / page sync) executes it without human help.
    relayer.execSafeTransaction.mockResolvedValueOnce({ txHash: EXEC_HASH });
    const res = await tryExecute({ fundId: FUND.id, transactionId: tx.id as string });
    expect(res.executed).toBe(true);
    err.mockRestore();
  });

  it("judges readiness from the chain's threshold, not the cached one", async () => {
    seed({ threshold: 2, owners: OWNERS_3 });
    // Threshold lowered to 1 in Safe{Wallet}; the DB still says 2.
    relayer.readSafeState.mockResolvedValue({
      deployed: true,
      owners: OWNERS_3.map((o) => o.address),
      threshold: 1,
      nonce: 0,
    });

    const res = await transfer("u-a");

    expect(res.executed).toBe(true);
  });

  it("retryExecution reconciles a FAILED tx that did mine when the nonce moved on", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });
    const revert = Object.assign(new SafeError("relayer_failed", "no receipt yet"), { txHash: EXEC_HASH });
    relayer.execSafeTransaction.mockRejectedValueOnce(revert);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(transfer("u-a")).rejects.toMatchObject({ code: "relayer_failed" });
    const tx = db.fundSafeTransaction[0];
    expect(tx.status).toBe("FAILED");

    relayer.readSafeState.mockResolvedValue({ deployed: true, owners: [OWNERS_3[0].address], threshold: 1, nonce: 1 });
    relayer.findSafeExecution.mockResolvedValue({ txHash: EXEC_HASH, success: true, blockNumber: BigInt(1) });

    const retried = await retryExecution({ fundId: FUND.id, transactionId: tx.id as string });
    expect(retried).toEqual({ executed: true, txHash: EXEC_HASH });
    expect(tx).toMatchObject({ status: "EXECUTED", executedBy: "relayer" });
    expect(db.tokenOperation).toHaveLength(1);
    err.mockRestore();
  });
});

describe("signTransaction", () => {
  it("refuses a second signature by the same owner", async () => {
    seed({ threshold: 2, owners: OWNERS_3 });
    const proposed = await transfer("u-a");
    await expect(
      signTransaction({ fundId: FUND.id, transactionId: proposed.transactionId, userId: "u-a" }),
    ).rejects.toMatchObject({ code: "already_signed" });
    expect(db.fundSafeSignature).toHaveLength(1);
  });
});

describe("tryExecute", () => {
  it("does not execute when the guarded claim loses the race", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });
    relayer.isRelayerConfigured.mockReturnValue(false);
    const proposed = await transfer("u-a");
    expect(db.fundSafeTransaction[0].status).toBe("PENDING");

    relayer.isRelayerConfigured.mockReturnValue(true);
    const spy = vi
      .spyOn(fake.prisma.fundSafeTransaction, "updateMany")
      .mockResolvedValueOnce({ count: 0 });
    const res = await tryExecute({ fundId: FUND.id, transactionId: proposed.transactionId });

    expect(res).toEqual({ executed: false, txHash: null, reason: "not_pending" });
    expect(relayer.execSafeTransaction).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("waits for an earlier nonce", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });
    relayer.isRelayerConfigured.mockReturnValue(false);
    await transfer("u-a", "1");
    const second = await transfer("u-a", "2");
    relayer.isRelayerConfigured.mockReturnValue(true);

    const res = await tryExecute({ fundId: FUND.id, transactionId: second.transactionId });
    expect(res.reason).toBe("nonce");
    expect(relayer.execSafeTransaction).not.toHaveBeenCalled();
  });
});

describe("rejections and owner changes", () => {
  it("a rejection reuses the target nonce and supersedes it once executed", async () => {
    seed({ threshold: 2, owners: OWNERS_3 });
    const target = await transfer("u-a");
    const rejection = await proposeRejection({ fund: FUND, safeId, userId: "u-a", transactionId: target.transactionId });

    const row = db.fundSafeTransaction.find((t) => t.id === rejection.transactionId)!;
    expect(row).toMatchObject({ kind: "REJECTION", nonce: 0, to: SAFE, data: "0x", value: "0" });
    expect(row.summary).toEqual({ kind: "REJECTION", rejectsNonce: 0 });

    await signTransaction({ fundId: FUND.id, transactionId: rejection.transactionId, userId: "u-b" });
    expect(row.status).toBe("EXECUTED");
    expect(db.fundSafeTransaction.find((t) => t.id === target.transactionId)!.status).toBe("SUPERSEDED");
  });

  it("an executed owner change refreshes owners through sync", async () => {
    seed({ threshold: 1, owners: [OWNERS_3[0]] });
    const res = await proposeOwnerChange({
      fund: FUND,
      safeId,
      userId: "u-a",
      input: { safeId, change: { kind: "ADD_OWNER", address: D, label: "Auditor", threshold: 1 } },
    });
    expect(res.executed).toBe(true);
    const row = db.fundSafeTransaction[0];
    expect(row).toMatchObject({ kind: "ADD_OWNER", to: SAFE });
    expect(row.summary).toEqual({ kind: "ADD_OWNER", owner: D, ownerLabel: "Auditor", threshold: 1 });
    expect(sync.syncSafe).toHaveBeenCalledWith({ fundId: FUND.id, safeId, force: true });
  });
});
