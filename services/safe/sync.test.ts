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
  findSafeExecution: vi.fn(),
  readSafeConfig: vi.fn(),
  describeSafeConfigDrift: vi.fn<() => string | null>(() => null),
  verifyContractSignature: vi.fn(),
  hasContractCode: vi.fn(),
}));
vi.mock("@/services/safe/relayer", () => relayer);

const txService = vi.hoisted(() => ({
  isTxServiceEnabled: vi.fn(),
  proposeTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  getMultisigTransaction: vi.fn(),
  listPendingTransactions: vi.fn(),
}));
vi.mock("@/services/safe/tx-service", () => txService);

vi.mock("@/services/safe/signer", () => ({
  findFundSigner: vi.fn(),
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

import { contractSignature } from "./passkey-signature";
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
const P = getAddress("0x1111111111111111111111111111111111111111"); // a member's passkey signer
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
  txService.listPendingTransactions.mockResolvedValue([]);
  relayer.findSafeExecution.mockResolvedValue(null);

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

function passkeyOf(userId: string, address: string, over: Record<string, unknown> = {}) {
  return {
    id: `pk-${userId}`,
    fundId: FUND_ID,
    userId,
    address,
    credentialId: `cred-${userId}`,
    publicKeyX: "0x01",
    publicKeyY: "0x02",
    verifiers: "0x0100",
    counter: 0,
    backupEligible: true,
    backupState: true,
    transports: null,
    deployedAt: new Date(),
    replacedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

describe("passkey owners in sync", () => {
  it("adds a chain owner held by a member's passkey signer as PASSKEY", async () => {
    db.fundPasskeySigner.push(passkeyOf("u-p", P));
    chain([A, X, P], 2, 0);
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    const row = db.fundSafeOwner.find((o) => o.address === P);
    expect(row).toMatchObject({ kind: "PASSKEY", passkeyId: "pk-u-p", signerId: null, removedAt: null });
  });

  it("imports a contract-signature confirmation only when the owner contract accepts it", async () => {
    db.fundPasskeySigner.push(passkeyOf("u-p", P));
    db.fundSafeOwner.push({ id: "o-p", safeId: SAFE_ID, address: P, kind: "PASSKEY", signerId: null, passkeyId: "pk-u-p", label: null, removedAt: null });
    chain([A, X, P], 3, 0);
    const tx = addTx({ safeTxHash: EXT_HASH });
    const sig = contractSignature(P, "0xabcdef");
    txService.listPendingTransactions.mockResolvedValue([
      { safeTxHash: EXT_HASH, confirmations: [{ owner: P, signature: sig, signatureType: "CONTRACT_SIGNATURE" }] },
    ]);
    relayer.verifyContractSignature.mockResolvedValueOnce(false);
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(db.fundSafeSignature.filter((s) => s.transactionId === tx.id)).toHaveLength(0);
    expect(relayer.verifyContractSignature).toHaveBeenCalledWith({ chainId: 100, owner: P, hash: EXT_HASH, signature: "0xabcdef" });
    expect(recoverSafeTxSigner).not.toHaveBeenCalled();

    relayer.verifyContractSignature.mockResolvedValueOnce(true);
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    const stored = db.fundSafeSignature.find((s) => s.transactionId === tx.id);
    expect(stored).toMatchObject({ ownerAddress: P, source: "SAFE_WALLET", signature: sig });
  });

  it("retires a legacy key once its migration swap executed, and erases it when no unarchived Safe lists it", async () => {
    db.fundPasskeySigner.push(passkeyOf("u-a", P));
    addTx({
      kind: "SWAP_OWNER",
      status: "EXECUTED",
      nonce: 0,
      summary: { kind: "SWAP_OWNER", oldOwner: A, oldOwnerLabel: null, newOwner: P, newOwnerLabel: null, migration: "server_key" },
    });
    // Another unarchived Safe still lists A: retired, ciphertext kept.
    db.fundSafe.push({ ...db.fundSafe[0]!, id: "safe-2", address: Y, archivedAt: null });
    db.fundSafeOwner.push({ id: "o-a2", safeId: "safe-2", address: A, kind: "MEMBER", signerId: "signer-a", label: null, removedAt: null });
    chain([P, X], 2, 1);
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    const signer = db.fundSigner.find((s) => s.id === "signer-a")!;
    expect(signer.retiredAt).toBeInstanceOf(Date);
    expect(signer.privateKeyEnc).toBe("enc");
    expect(db.fundSafeOwner.find((o) => o.id === "o-a")!.removedAt).toBeInstanceOf(Date);

    // The other Safe is archived: nothing unarchived lists A any more → erased.
    db.fundSafe.find((s) => s.id === "safe-2")!.archivedAt = new Date();
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(signer.privateKeyEnc).toBeNull();
    expect(signer.keyDeletedAt).toBeInstanceOf(Date);
  });
});

describe("syncSafe", () => {
  it("imports a verified Safe{Wallet} confirmation and executes at threshold", async () => {
    const tx = addTx();
    db.fundSafeSignature.push({ id: "s-a", transactionId: tx.id, ownerAddress: A, signature: sig("1a"), source: "LACAISSE" });
    txService.listPendingTransactions.mockResolvedValue([
      {
        safeTxHash: tx.safeTxHash,
        nonce: 0,
        isExecuted: false,
        isSuccessful: null,
        transactionHash: null,
        executionDate: null,
        confirmations: [
          { owner: X.toLowerCase(), signature: sig("2b"), signatureType: "EOA", submissionDate: "" },
        ],
      },
    ]);
    recoverSafeTxSigner.mockResolvedValue(X);

    const res = await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(res).toMatchObject({ synced: true, executed: 1, errors: 0 });
    expect(txService.listPendingTransactions).toHaveBeenCalledTimes(1);
    const imported = db.fundSafeSignature.find((s) => s.ownerAddress === X);
    expect(imported).toMatchObject({ source: "SAFE_WALLET", signature: sig("2b") });
    expect(relayer.execSafeTransaction).toHaveBeenCalledTimes(1);
    expect(tx).toMatchObject({ status: "EXECUTED", executedBy: "relayer", txHash: EXEC_HASH });
    expect(db.fundSafe[0].lastSyncedAt).toBeInstanceOf(Date);
  });

  it("skips a confirmation whose signature does not recover to its owner", async () => {
    const tx = addTx();
    txService.listPendingTransactions.mockResolvedValue([
      {
        safeTxHash: tx.safeTxHash,
        isExecuted: false,
        isSuccessful: null,
        transactionHash: null,
        executionDate: null,
        confirmations: [{ owner: X, signature: sig("2b"), signatureType: "EOA", submissionDate: "" }],
      },
    ]);
    recoverSafeTxSigner.mockResolvedValue(Y);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(db.fundSafeSignature).toHaveLength(0);
    expect(tx.status).toBe("PENDING");
    warn.mockRestore();
  });

  it("marks a transaction executed outside La Caisse as EXECUTED external (from the Safe's event)", async () => {
    const tx = addTx();
    chain([A, X], 2, 1);
    relayer.findSafeExecution.mockResolvedValue({ txHash: EXT_HASH, success: true, blockNumber: BigInt(1) });

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(relayer.findSafeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ safeTxHash: tx.safeTxHash }),
    );
    expect(tx).toMatchObject({ status: "EXECUTED", executedBy: "external", txHash: EXT_HASH });
    expect(tx.executedAt).toBeInstanceOf(Date);
    expect(db.tokenOperation).toHaveLength(1);
    expect(db.tokenOperation[0]).toMatchObject({ type: "TRANSFER", amount: "5", txHash: EXT_HASH });
    expect(relayer.execSafeTransaction).not.toHaveBeenCalled();
  });

  it("supersedes PENDING and FAILED transactions whose nonce was consumed by another tx", async () => {
    const pending = addTx({ nonce: 0 });
    const failed = addTx({ nonce: 0, status: "FAILED", errorMessage: "relayer_failed: boom" });
    chain([A, X], 2, 1);

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(pending.status).toBe("SUPERSEDED");
    expect(failed.status).toBe("SUPERSEDED");
  });

  it("recovers a FAILED relayer execution that did mine (lost bookkeeping)", async () => {
    const tx = addTx({ nonce: 0, status: "FAILED", txHash: EXEC_HASH, errorMessage: "execution timed out" });
    chain([A, X], 2, 1);
    relayer.findSafeExecution.mockResolvedValue({ txHash: EXEC_HASH, success: true, blockNumber: BigInt(1) });

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(tx).toMatchObject({ status: "EXECUTED", executedBy: "relayer", txHash: EXEC_HASH });
    expect(db.tokenOperation).toHaveLength(1);
  });

  it("re-proposes to the Transaction Service a PENDING tx the service does not know", async () => {
    const tx = addTx();
    db.fundSafeSignature.push({ id: "s-a", transactionId: tx.id, ownerAddress: A, signature: sig("1a"), source: "LACAISSE" });

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(txService.proposeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ safeTxHash: tx.safeTxHash, sender: A, signature: sig("1a") }),
    );
  });

  it("never touches the Transaction Service for a Safe with team-only owners", async () => {
    db.fundSafeOwner.splice(1, 1); // drop the external owner
    chain([A], 1, 0);
    addTx();
    relayer.isRelayerConfigured.mockReturnValue(false);

    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(txService.listPendingTransactions).not.toHaveBeenCalled();
    expect(txService.proposeTransaction).not.toHaveBeenCalled();
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

  it("keeps a PENDING tx and notes the problem on the safe when the execution lookup fails", async () => {
    const tx = addTx();
    chain([A, X], 2, 1);
    relayer.findSafeExecution.mockRejectedValue(new Error("eth_getLogs: block range too wide"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });

    expect(res).toMatchObject({ synced: true, executed: 0, errors: 1 });
    expect(tx.status).toBe("PENDING");
    expect(db.fundSafe[0].errorMessage).toBe(
      `sync: execution lookup failed (${tx.id}): eth_getLogs: block range too wide`,
    );
    expect(db.fundSafe[0].lastSyncedAt).toBeInstanceOf(Date);

    // The next clean pass clears the note.
    relayer.findSafeExecution.mockResolvedValue({ txHash: EXT_HASH, success: true, blockNumber: BigInt(1) });
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(tx.status).toBe("EXECUTED");
    expect(db.fundSafe[0].errorMessage).toBeNull();
    warn.mockRestore();
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

describe("syncSafe configuration drift (S6)", () => {
  it("records non-canonical wiring on the Safe and stops executing until it clears", async () => {
    // Fully signed at threshold 1 — would execute on a clean Safe.
    const tx = addTx({ nonce: 1 });
    db.fundSafeSignature.push({
      id: "sig-a",
      transactionId: tx.id,
      ownerAddress: A,
      signature: sig("1a"),
      source: "LACAISSE",
    });
    chain([A, X], 1, 1);
    relayer.describeSafeConfigDrift.mockReturnValue("module(s) 0x2222222222222222222222222222222222222222");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(first.executed).toBe(0);
    expect(db.fundSafe[0].configWarning).toContain("module(s) 0x2222");
    expect(relayer.execSafeTransaction).not.toHaveBeenCalled();
    expect(tx.status).toBe("PENDING");

    // Drift fixed in Safe{Wallet}: the next pass clears the warning and runs it.
    relayer.describeSafeConfigDrift.mockReturnValue(null);
    const second = await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(db.fundSafe[0].configWarning).toBeNull();
    expect(second.executed).toBe(1);
    expect(tx.status).toBe("EXECUTED");
    warn.mockRestore();
  });

  it("keeps the previous verdict and notes the problem when the config read fails", async () => {
    chain([A, X], 2, 1);
    db.fundSafe[0].configWarning = "guard 0x1111111111111111111111111111111111111111";
    relayer.readSafeConfig.mockRejectedValue(new Error("rpc down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(db.fundSafe[0].configWarning).toBe("guard 0x1111111111111111111111111111111111111111");
    expect(db.fundSafe[0].errorMessage).toBe("sync: configuration check failed");
    warn.mockRestore();
  });
});

describe("syncSafe superseded annotation (S12)", () => {
  it("says when the nonce went to a transaction La Caisse never recorded", async () => {
    const tx = addTx({ nonce: 0 });
    chain([A, X], 2, 1);
    relayer.findSafeExecution.mockResolvedValue(null);
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(tx.status).toBe("SUPERSEDED");
    expect(tx.errorMessage).toContain("did not record");
  });

  it("stays silent when a sibling row at that nonce executed", async () => {
    const tx = addTx({ nonce: 0 });
    addTx({ nonce: 0, status: "EXECUTED", kind: "REJECTION" });
    chain([A, X], 2, 1);
    relayer.findSafeExecution.mockResolvedValue(null);
    await syncSafe({ fundId: FUND_ID, safeId: SAFE_ID, force: true });
    expect(tx.status).toBe("SUPERSEDED");
    expect(tx.errorMessage).toBeNull();
  });
});
