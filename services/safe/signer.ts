// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { decryptSecret, encryptSecret, envelopeVersion } from "@/services/crypto/secret";
import { prisma } from "@/services/db/prisma";
import { safeTxTypedData } from "@/services/safe/safe-tx";
import type { Address, Hex, SafeTx } from "@/services/safe/types";

// Per-member Safe signer keys. Each (fund, user) pair gets one secp256k1 key,
// generated on first need and stored AES-256-GCM encrypted in
// `FundSigner.privateKeyEnc` (envelope from services/crypto/secret.ts, same
// as the token minter in services/token/minter.ts). The address is the Safe
// owner La Caisse signs with on that member's behalf. Keys never leave this
// module in plaintext and are never logged.
//
// The envelope is bound (GCM additional data, envelope v2) to the row it
// belongs to — `signer:<fundId>:<userId>` — so a ciphertext copied onto
// another FundSigner row, or a row whose userId is re-pointed at another
// account, no longer decrypts: a database write alone can't make La Caisse
// sign with someone else's key (review S3). Keys sealed before the binding
// existed (v1) still decrypt and are re-sealed as v2 the next time they sign.
// Module map: services/safe/config.ts.

export function signerBinding(fundId: string, userId: string): string {
  return `signer:${fundId}:${userId}`;
}

export function generateSigner(
  fundId: string,
  userId: string,
): { address: Address; privateKeyEnc: string } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    privateKeyEnc: encryptSecret(privateKey, signerBinding(fundId, userId)),
  };
}

const signerSelect = {
  id: true,
  fundId: true,
  userId: true,
  address: true,
  privateKeyEnc: true,
} as const;

export type SignerRow = {
  id: string;
  fundId: string;
  userId: string;
  address: Address;
  privateKeyEnc: string;
};

function toSigner(row: {
  id: string;
  fundId: string;
  userId: string;
  address: string;
  privateKeyEnc: string;
}): SignerRow {
  return { ...row, address: getAddress(row.address) };
}

/**
 * The member's signer for this fund, creating it on first use. A concurrent
 * create for the same (fundId, userId) loses on the unique index (P2002) and
 * re-reads the winner's row, so a member never ends up with two keys.
 */
export async function getOrCreateFundSigner(fundId: string, userId: string): Promise<SignerRow> {
  const where = { fundId_userId: { fundId, userId } };
  const existing = await prisma.fundSigner.findUnique({ where, select: signerSelect });
  if (existing) return toSigner(existing);

  const fresh = generateSigner(fundId, userId);
  try {
    const created = await prisma.fundSigner.create({
      data: { fundId, userId, address: fresh.address, privateKeyEnc: fresh.privateKeyEnc },
      select: signerSelect,
    });
    return toSigner(created);
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    const winner = await prisma.fundSigner.findUnique({ where, select: signerSelect });
    if (!winner) throw e;
    return toSigner(winner);
  }
}

/**
 * EIP-712 signature (v 27/28) of the SafeTx by a stored signer key. The key
 * is unsealed with the row's binding; a legacy (v1) envelope is re-sealed
 * as v2 on the way, best-effort.
 */
export async function signSafeTxWithSigner(
  signer: { id: string; fundId: string; userId: string; privateKeyEnc: string },
  a: { chainId: number; safeAddress: Address; tx: SafeTx },
): Promise<Hex> {
  const binding = signerBinding(signer.fundId, signer.userId);
  const privateKey = decryptSecret(signer.privateKeyEnc, binding) as Hex;
  if (envelopeVersion(signer.privateKeyEnc) === "v1") {
    try {
      await prisma.fundSigner.updateMany({
        where: { id: signer.id, fundId: signer.fundId, userId: signer.userId },
        data: { privateKeyEnc: encryptSecret(privateKey, binding) },
      });
    } catch (e) {
      console.warn("[safe] signer re-seal failed", signer.id, e instanceof Error ? e.message : e);
    }
  }
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData(safeTxTypedData(a));
}
