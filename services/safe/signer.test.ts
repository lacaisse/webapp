// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  fundSigner: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma: db }));

import { encryptSecret } from "@/services/crypto/secret";
import { buildSafeTx, recoverSafeTxSigner } from "@/services/safe/safe-tx";
import {
  generateSigner,
  getOrCreateFundSigner,
  signSafeTxWithSigner,
  signerBinding,
} from "@/services/safe/signer";
import type { Address } from "@/services/safe/types";

const SAFE: Address = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0";
// Hardhat's well-known test account #0 key (public, never funded).
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

beforeEach(() => {
  vi.stubEnv("APP_CRED_KEY", "11".repeat(32));
  db.fundSigner.findUnique.mockReset();
  db.fundSigner.create.mockReset();
  db.fundSigner.updateMany.mockReset().mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signer", () => {
  it("generates a key sealed to its (fund, user) row whose signatures recover to its address", async () => {
    const signer = { id: "s1", fundId: "f1", userId: "u1", ...generateSigner("f1", "u1") };
    expect(signer.privateKeyEnc.startsWith("v2:")).toBe(true);
    expect(signer.privateKeyEnc).not.toContain(signer.address.slice(2));
    const tx = buildSafeTx({ to: SAFE, nonce: BigInt(1) });
    const signature = await signSafeTxWithSigner(signer, { chainId: 100, safeAddress: SAFE, tx });
    await expect(
      recoverSafeTxSigner({ chainId: 100, safeAddress: SAFE, tx, signature }),
    ).resolves.toBe(signer.address);
    expect(db.fundSigner.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a key copied onto another row (binding mismatch)", async () => {
    const stolen = { id: "s9", fundId: "f1", userId: "u2", ...generateSigner("f1", "u1") };
    const tx = buildSafeTx({ to: SAFE, nonce: BigInt(1) });
    await expect(
      signSafeTxWithSigner(stolen, { chainId: 100, safeAddress: SAFE, tx }),
    ).rejects.toThrow();
  });

  it("still signs with a legacy v1 key and re-seals it as v2", async () => {
    const legacy = { id: "s1", fundId: "f1", userId: "u1", privateKeyEnc: encryptSecret(TEST_KEY) };
    expect(legacy.privateKeyEnc.startsWith("v1:")).toBe(true);
    const tx = buildSafeTx({ to: SAFE, nonce: BigInt(1) });
    const signature = await signSafeTxWithSigner(legacy, { chainId: 100, safeAddress: SAFE, tx });
    await expect(
      recoverSafeTxSigner({ chainId: 100, safeAddress: SAFE, tx, signature }),
    ).resolves.toBe(TEST_ADDR);
    const call = db.fundSigner.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "s1", fundId: "f1", userId: "u1" });
    expect(String(call.data.privateKeyEnc).startsWith("v2:")).toBe(true);
  });

  it("names the binding after the row", () => {
    expect(signerBinding("f1", "u1")).toBe("signer:f1:u1");
  });

  it("returns the existing signer", async () => {
    const row = { id: "s1", fundId: "f1", userId: "u1", address: SAFE.toLowerCase(), privateKeyEnc: "v1:x" };
    db.fundSigner.findUnique.mockResolvedValue(row);
    await expect(getOrCreateFundSigner("f1", "u1")).resolves.toEqual({ ...row, address: SAFE });
    expect(db.fundSigner.findUnique.mock.calls[0][0].where).toEqual({
      fundId_userId: { fundId: "f1", userId: "u1" },
    });
    expect(db.fundSigner.create).not.toHaveBeenCalled();
  });

  it("creates one, and re-reads the winner on a P2002 race", async () => {
    db.fundSigner.findUnique.mockResolvedValueOnce(null);
    db.fundSigner.create.mockImplementation(async ({ data }) => ({ id: "s2", ...data }));
    const created = await getOrCreateFundSigner("f1", "u1");
    expect(created.id).toBe("s2");
    expect(db.fundSigner.create.mock.calls[0][0].data).toMatchObject({ fundId: "f1", userId: "u1" });
    expect(String(db.fundSigner.create.mock.calls[0][0].data.privateKeyEnc).startsWith("v2:")).toBe(true);

    const winner = { id: "s3", fundId: "f1", userId: "u1", address: SAFE, privateKeyEnc: "v1:y" };
    db.fundSigner.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    db.fundSigner.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(getOrCreateFundSigner("f1", "u1")).resolves.toEqual(winner);
  });
});
