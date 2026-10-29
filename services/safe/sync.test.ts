// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

// services/safe/sync.ts against an in-memory Prisma (test-fake-prisma.ts),
// with the real proposals.ts for execution / bookkeeping. Chain reads, the
// Safe Tx Service and signature recovery are faked.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", async () => ({
  prisma: (await import("./test-fake-prisma")).fake.prisma,
}));

const relayer = vi.hoisted(() => ({
  isRelayerConfigured: vi.fn(),
  readSafeState: vi.fn(),
  deploySafe: vi.fn(),
  execSafeTransaction: vi.fn(),
  errorTxHash: vi.fn(() => null),
}));
vi.mock("@/services/safe/relayer", () => relayer);

const txService = vi.hoisted(() => ({
  isTxServiceEnabled: vi.fn(),
  proposeTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  getMultisigTransaction: vi.fn(),
}));
vi.mock("@/services/safe/tx-service", () => txService);

vi.mock("@/services/safe/signer", () => ({
  getOrCreateFundSigner: vi.fn(),
  signSafeTxWithSigner: vi.fn(),
}));

const recoverSafeTxSigner = vi.hoisted(() => vi.fn());
vi.mock("@/services/safe/safe-tx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./safe-tx")>()),
  recoverSafeTxSigner,
}));

vi.mock("@/services/transaction-annotation/annotate", () => ({
  annotateTransaction: vi.fn(),
  ANNOTATION_KINDS: { safeTransfer: "SAFE_TRANSFER" },
  ANNOTATION_TRIGGERS: { safeTransfer: "SAFE_TRANSFER" },
}));

import { fake, resetFake } from "./test-fake-prisma";
import { syncSafe } from "./sync";

const db = fake.db;
const FUND_ID = "fund-1";
const SAFE_ID = "safe-1";
const SAFE = getAddress("0x5afe00000000000000000000000000000000cafe");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const RECIPIENT = getAddress("0x9999999999999999999999999999999999999999");
const A = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // member
const X = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"); // external
const Y = getAddress("0x7777777777777777777777777777777777777777");
const EXEC_HASH = `0x${"e1".repeat(32)}`;
const EXT_HASH = `0x${"e2".repeat(32)}`;
const sig = (b: string) => `0x${b.repeat(65)}`;

function chain(owners: string[], threshold: number, nonce: number) {
  relayer.readSafeState.mockResolvedValue({ deployed: true, owners, threshold, nonce });
}

function addTx(over: Record<string, unknown> = {}) {
  const row = {
    id: `tx-${db.fundSafeTransaction.length + 1}`,
    safeId: SAFE_ID,
    nonce: 0,
    kind: "TOKEN_TRANSFER",
    to: TOKEN,
    value: "0",
    data: "0x",
    operation: 0,
    safeTxHash: `0x${String(db.fundSafeTransaction.length + 1).padStart(64, "0")}`,
    summary: { kind: "TOKEN_TRANSFER", amount: "5", recipient: RECIPIENT, recipientLabel: null },
    note: null,
    status: "PENDING",
    proposedById: "u-a",
    txHash: null,
    executedAt: null,
    executedBy: null,
    errorMessage: null,
    tokenOperationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  db.fundSafeTransaction.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFake();
  relayer.isRelayerConfigured.mockReturnValue(true);
  relayer.execSafeTransaction.mockResolvedValue({ txHash: EXEC_HASH });
  txService.isTxServiceEnabled.mockReturnValue(true);
  txService.getMultisigTransaction.mockResolvedValue(null);

  db.fundSigner.push({ id: "signer-a", fundId: FUND_ID, userId: "u-a", address: A, privateKeyEnc: "enc" });
  db.fundSafe.push({
    id: SAFE_ID,
    fundId: FUND_ID,
    name: "Treasury",
    chainId: 100,
    saltNonce: "1",
    address: SAFE,
    threshold: 2,
    status: "ACTIVE",
    archivedAt: null,
    lastSyncedAt: null,
    errorMessage: null,
  });
  db.fundSafeOwner.push(
    { id: "o-a", safeId: SAFE_ID, address: A, kind: "MEMBER", signerId: "signer-a", label: null, removedAt: null },
    { id: "o-x", safeId: SAFE_ID, address: X, kind: "EXTERNAL", signerId: null, label: "Bank", removedAt: null },
  );
  chain([A, X], 2, 0);
});

describe("syncSafe", () => {
  it("imports a verified Safe{Wallet} confirmation and executes at threshold", async () => {
    const tx = addTx();
    db.fundSafeSignature.push({ id: "s-a", transactionId: tx.id, ownerAddress: A, signature: sig("1a"), source: "LACAISSE" });
    txService.getMultisigTransaction.mockResolvedValue({
      safeTxHash: tx.safeTxHash,
      nonce: 0,
      isExecuted: false,
      isSuccessful: null,
      transactionHash: null,
      executionDate: null,
      confirmations: [
        { owner: X.toLowerCase(), signature: sig("2b"), signatureType: "EOA", submissionDate: "" },
      ],
    });
    recoverSafeTxSigner.mockResolvedValue(X);

    const res = await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(res).toMatchObject({ synced: true, executed: 1, errors: 0 });
    const imported = db.fundSafeSignature.find((s) => s.ownerAddress === X);
    expect(imported).toMatchObject({ source: "SAFE_WALLET", signature: sig("2b") });
    expect(relayer.execSafeTransaction).toHaveBeenCalledTimes(1);
    expect(tx).toMatchObject({ status: "EXECUTED", executedBy: "relayer", txHash: EXEC_HASH });
    expect(db.fundSafe[0].lastSyncedAt).toBeInstanceOf(Date);
  });

  it("skips a confirmation whose signature does not recover to its owner", async () => {
    const tx = addTx();
    txService.getMultisigTransaction.mockResolvedValue({
      safeTxHash: tx.safeTxHash,
      isExecuted: false,
      isSuccessful: null,
      transactionHash: null,
      executionDate: null,
      confirmations: [{ owner: X, signature: sig("2b"), signatureType: "EOA", submissionDate: "" }],
    });
    recoverSafeTxSigner.mockResolvedValue(Y);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(db.fundSafeSignature).toHaveLength(0);
    expect(tx.status).toBe("PENDING");
    warn.mockRestore();
  });

  it("marks a transaction executed outside La Caisse as EXECUTED external", async () => {
    const tx = addTx();
    chain([A, X], 2, 1);
    txService.getMultisigTransaction.mockResolvedValue({
      safeTxHash: tx.safeTxHash,
      isExecuted: true,
      isSuccessful: true,
      transactionHash: EXT_HASH,
      executionDate: "2026-10-29T10:00:00Z",
      confirmations: [],
    });

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(tx).toMatchObject({ status: "EXECUTED", executedBy: "external", txHash: EXT_HASH });
    expect(tx.executedAt).toEqual(new Date("2026-10-29T10:00:00Z"));
    expect(db.tokenOperation).toHaveLength(1);
    expect(db.tokenOperation[0]).toMatchObject({ type: "TRANSFER", amount: "5", txHash: EXT_HASH });
    expect(relayer.execSafeTransaction).not.toHaveBeenCalled();
  });

  it("supersedes a PENDING transaction whose nonce was consumed on chain", async () => {
    const tx = addTx({ nonce: 0 });
    chain([A, X], 2, 1);

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(tx.status).toBe("SUPERSEDED");
  });

  it("fails a stuck EXECUTING transaction after 10 minutes", async () => {
    const tx = addTx({ status: "EXECUTING", updatedAt: new Date(Date.now() - 11 * 60 * 1000) });

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(tx).toMatchObject({ status: "FAILED", errorMessage: "execution timed out" });
  });

  it("adds an owner that appeared on chain as EXTERNAL and updates the threshold", async () => {
    chain([A, X, Y], 3, 0);

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    const added = db.fundSafeOwner.find((o) => o.address === Y);
    expect(added).toMatchObject({ kind: "EXTERNAL", label: null, removedAt: null });
    expect(db.fundSafe[0].threshold).toBe(3);
  });

  it("marks an owner gone from chain as removed, and restores it when it returns", async () => {
    chain([A], 1, 0);
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    const x = db.fundSafeOwner.find((o) => o.address === X)!;
    expect(x.removedAt).toBeInstanceOf(Date);
    expect(db.fundSafeOwner.find((o) => o.address === A)!.removedAt).toBeNull();

    chain([A, X], 1, 0);
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(x.removedAt).toBeNull();
  });

  it("skips a recent sync unless forced, and never syncs another fund's Safe", async () => {
    db.fundSafe[0].lastSyncedAt = new Date();
    expect(await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID })).toMatchObject({ synced: false });
    expect(await syncSafe({ fundId: "fund-2", safeId: SAFE_ID, force: true })).toMatchObject({ synced: false });
    expect(relayer.readSafeState).not.toHaveBeenCalled();
  });

  it("stores the error on the safe when the chain read fails", async () => {
    relayer.readSafeState.mockRejectedValue(new Error("rpc down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(res.synced).toBe(false);
    expect(db.fundSafe[0].errorMessage).toBe("sync: rpc down");
    warn.mockRestore();
  });
});
