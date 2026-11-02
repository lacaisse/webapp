// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { decryptSecret, encryptSecret, envelopeVersion } from "@/services/crypto/secret";
import { prisma } from "@/services/db/prisma";
import { safeTxTypedData } from "@/services/safe/safe-tx";
import { SafeError, type Address, type Hex, type SafeTx } from "@/services/safe/types";

// LEGACY server-held Safe signer keys. The first Safe release gave each
// (fund, user) pair one secp256k1 key, stored AES-256-GCM encrypted in
// `FundSigner.privateKeyEnc` (envelope from services/crypto/secret.ts, same
// as the token minter in services/token/minter.ts), and signed on the
// member's behalf. That is custody: a server breach yields one signature per
// member. Members now own their Safe key as a passkey (passkey-signers.ts),
// so NO new FundSigner row is ever created here — `generateSigner` only
// remains for the unit tests of the envelope binding — and a stored key
// signs only on a Safe that still lists it as a MEMBER owner, until the
// guided migration (migration.ts) swaps it out and the sweep erases the
// ciphertext (`privateKeyEnc` null, `keyDeletedAt`).
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
  privateKeyEnc: string | null; // null once erased by the migration sweep
};

function toSigner(row: {
  id: string;
  fundId: string;
  userId: string;
  address: string;
  privateKeyEnc: string | null;
}): SignerRow {
  return { ...row, address: getAddress(row.address) };
}

/** The member's legacy server-held signer for this fund, if one ever existed. */
export async function findFundSigner(fundId: string, userId: string): Promise<SignerRow | null> {
  const row = await prisma.fundSigner.findUnique({
    where: { fundId_userId: { fundId, userId } },
    select: signerSelect,
  });
  return row ? toSigner(row) : null;
}

/**
 * EIP-712 signature (v 27/28) of the SafeTx by a stored signer key. The key
 * is unsealed with the row's binding; a legacy (v1) envelope is re-sealed
 * as v2 on the way, best-effort. Refused once the ciphertext was erased.
 */
export async function signSafeTxWithSigner(
  signer: { id: string; fundId: string; userId: string; privateKeyEnc: string | null },
  a: { chainId: number; safeAddress: Address; tx: SafeTx },
): Promise<Hex> {
  if (!signer.privateKeyEnc) {
    throw new SafeError(
      "server_key_retired",
      "This server-held key was retired: sign with your passkey instead",
    );
  }
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
