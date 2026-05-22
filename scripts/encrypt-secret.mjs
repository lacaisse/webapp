// SPDX-License-Identifier: AGPL-3.0-or-later
// Encrypts a secret (CitizenPay API key, token-minter private key, etc.)
// so it can be inserted into the matching `*Enc` column via SQL. Reads the
// same APP_CRED_KEY env var the runtime uses, so the output is decryptable
// by services/crypto/secret.ts.
//
// Usage:
//   node scripts/encrypt-secret.mjs <plaintext-secret>
//
// or, to avoid the secret appearing in shell history:
//   echo -n "<plaintext>" | node scripts/encrypt-secret.mjs
//
// Then SQL it in. For a CitizenPay API key:
//   UPDATE "Fund"
//      SET "citizenPayApiKeyId"  = '0xYourEthAddress',
//          "citizenPayApiKeyEnc" = 'v1:...'
//    WHERE id = '...';

import "dotenv/config";
import { createCipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;

const key = process.env.APP_CRED_KEY;
if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
  console.error("APP_CRED_KEY must be 64 hex characters (32 bytes).");
  console.error("Generate with: openssl rand -hex 32");
  process.exit(1);
}

async function readPlaintext() {
  if (process.argv[2]) return process.argv[2];
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const plaintext = await readPlaintext();
if (!plaintext) {
  console.error("Usage: node scripts/encrypt-secret.mjs <plaintext-secret>");
  console.error("   or: echo -n <plaintext> | node scripts/encrypt-secret.mjs");
  process.exit(1);
}

const iv = randomBytes(IV_LEN);
const cipher = createCipheriv(ALGORITHM, Buffer.from(key, "hex"), iv);
const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();
const envelope = `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;

process.stdout.write(envelope + "\n");
