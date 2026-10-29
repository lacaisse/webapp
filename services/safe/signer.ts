// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { decryptSecret, encryptSecret } from "@/services/crypto/secret";
import { prisma } from "@/services/db/prisma";
import { safeTxTypedData } from "@/services/safe/safe-tx";
import type { Address, Hex, SafeTx } from "@/services/safe/types";

// Per-member Safe signer keys. Each (fund, user) pair gets one secp256k1 key,
// generated on first need and stored AES-256-GCM encrypted in
// `FundSigner.privateKeyEnc` (envelope from services/crypto/secret.ts, same
// as the token minter in services/token/minter.ts). The address is the Safe
// owner La Caisse signs with on that member's behalf. Keys never leave this
// module in plaintext and are never logged.
// Module map: services/safe/config.ts.

export function generateSigner(): { address: Address; privateKeyEnc: string } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, privateKeyEnc: encryptSecret(privateKey) };
}

const signerSelect = { id: true, address: true, privateKeyEnc: true } as const;

function toSigner(row: { id: string; address: string; privateKeyEnc: string }) {
  return { id: row.id, address: getAddress(row.address), privateKeyEnc: row.privateKeyEnc };
}

/**
 * The member's signer for this fund, creating it on first use. A concurrent
 * create for the same (fundId, userId) loses on the unique index (P2002) and
 * re-reads the winner's row, so a member never ends up with two keys.
 */
export async function getOrCreateFundSigner(
  fundId: string,
  userId: string,
): Promise<{ id: string; address: Address; privateKeyEnc: string }> {
  const where = { fundId_userId: { fundId, userId } };
  const existing = await prisma.fundSigner.findUnique({ where, select: signerSelect });
  if (existing) return toSigner(existing);

  const fresh = generateSigner();
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

/** EIP-712 signature (v 27/28) of the SafeTx by a stored signer key. */
export async function signSafeTxWithSigner(
  signer: { privateKeyEnc: string },
  a: { chainId: number; safeAddress: Address; tx: SafeTx },
): Promise<Hex> {
  const account = privateKeyToAccount(decryptSecret(signer.privateKeyEnc) as Hex);
  return account.signTypedData(safeTxTypedData(a));
}
