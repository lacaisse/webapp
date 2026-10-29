// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  fundSigner: { findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma: db }));

import { buildSafeTx, recoverSafeTxSigner } from "@/services/safe/safe-tx";
import {
  generateSigner,
  getOrCreateFundSigner,
  signSafeTxWithSigner,
} from "@/services/safe/signer";
import type { Address } from "@/services/safe/types";

const SAFE: Address = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0";

beforeEach(() => {
  vi.stubEnv("APP_CRED_KEY", "11".repeat(32));
  db.fundSigner.findUnique.mockReset();
  db.fundSigner.create.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signer", () => {
  it("generates an encrypted key whose signatures recover to its address", async () => {
    const signer = generateSigner();
    expect(signer.privateKeyEnc.startsWith("v1:")).toBe(true);
    expect(signer.privateKeyEnc).not.toContain(signer.address.slice(2));
    const tx = buildSafeTx({ to: SAFE, nonce: BigInt(1) });
    const signature = await signSafeTxWithSigner(signer, { chainId: 100, safeAddress: SAFE, tx });
    await expect(
      recoverSafeTxSigner({ chainId: 100, safeAddress: SAFE, tx, signature }),
    ).resolves.toBe(signer.address);
  });

  it("returns the existing signer", async () => {
    const row = { id: "s1", address: SAFE.toLowerCase(), privateKeyEnc: "v1:x" };
    db.fundSigner.findUnique.mockResolvedValue(row);
    await expect(getOrCreateFundSigner("f1", "u1")).resolves.toEqual({
      id: "s1",
      address: SAFE,
      privateKeyEnc: "v1:x",
    });
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

    const winner = { id: "s3", address: SAFE, privateKeyEnc: "v1:y" };
    db.fundSigner.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    db.fundSigner.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(getOrCreateFundSigner("f1", "u1")).resolves.toEqual(winner);
  });
});
