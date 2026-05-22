// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { encryptSecret } from "@/services/crypto/secret";

// Per-fund minter key. Each fund owns a fresh secp256k1 keypair used to sign
// UserOps submitted through CitizenPay's bundler — mint/burn on the fund's
// token contract are authorised by the smart account counterfactually
// derived from this EOA (factory + salt convention TBD pending CP docs).
//
// The private key is stored AES-256-GCM encrypted in
// `Fund.tokenMinterPrivateKeyEnc` (envelope from services/crypto/secret.ts).
// The EOA address is stored plaintext in `Fund.tokenMinterEoaAddress` for
// display + audit; the smart-account address column stays null until the
// bundler factory is wired.
//
// Generation is pure — no DB write. Callers persist the returned columns in
// whatever transaction makes sense for them (fund create, backfill, rotate).

export type FundMinter = {
  privateKeyEnc: string;
  eoaAddress: string;
};

export function generateFundMinter(): FundMinter {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    privateKeyEnc: encryptSecret(privateKey),
    eoaAddress: account.address,
  };
}
