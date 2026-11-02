// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { randomBytes } from "node:crypto";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { getAddress, toHex } from "viem";

import { prisma } from "@/services/db/prisma";
import { passkeyVerifiersFor } from "@/services/safe/config";
import { replacementRefusal } from "@/services/safe/migration-state";
import { challengeForHash } from "@/services/safe/passkey-signature";
import {
  signingPasskeyRegistrationOptions,
  verifySigningAssertion,
  verifySigningRegistration,
  type VerifiedSigningAssertion,
} from "@/services/safe/passkey-webauthn";
import {
  deployPasskeySigner,
  hasContractCode,
  isRelayerConfigured,
  predictPasskeySignerAddress,
} from "@/services/safe/relayer";
import { SafeError, isSafeError, type Address, type Hex } from "@/services/safe/types";

// A member's Safe signing passkey per fund (FundPasskeySigner rows). The
// registration ceremony: the server mints a single-use challenge, the
// browser creates a dedicated WebAuthn credential, the server verifies the
// attestation (passkey-webauthn.ts), derives the signer contract address
// from (x, y, verifiers) through the factory (relayer.ts) and has the
// relayer deploy the proxy. No private key exists anywhere but on the
// member's authenticator. Module map: services/safe/config.ts.
//
// One ACTIVE row (replacedAt null) per (fund, user). `replace` registers a
// successor for a lost or compromised device: the old row is marked
// replaced, and every Safe that still lists its address shows the migration
// banner (migration.ts) until a swapOwner moved it to the new address.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_PREFIX = "safe-signing-passkey:";
// Every registration deploys a signer contract on the relayer's gas, so a
// replacement is refused while a previous one still owns a Safe (its swap is
// pending) and beyond a few registrations a day (migration-state.ts
// replacementRefusal).
export const MAX_REGISTRATIONS_PER_DAY = 3;

export const passkeySignerSelect = {
  id: true,
  fundId: true,
  userId: true,
  address: true,
  credentialId: true,
  publicKeyX: true,
  publicKeyY: true,
  verifiers: true,
  counter: true,
  backupEligible: true,
  backupState: true,
  transports: true,
  deployedAt: true,
  replacedAt: true,
  createdAt: true,
} as const;

export type PasskeySignerRow = {
  id: string;
  fundId: string;
  userId: string;
  address: Address;
  credentialId: string;
  publicKeyX: Hex;
  publicKeyY: Hex;
  verifiers: Hex;
  counter: number;
  backupEligible: boolean;
  backupState: boolean;
  transports: string | null;
  deployedAt: Date | null;
  replacedAt: Date | null;
  createdAt: Date;
};

function toRow(r: {
  id: string;
  fundId: string;
  userId: string;
  address: string;
  credentialId: string;
  publicKeyX: string;
  publicKeyY: string;
  verifiers: string;
  counter: number;
  backupEligible: boolean;
  backupState: boolean;
  transports: string | null;
  deployedAt: Date | null;
  replacedAt: Date | null;
  createdAt: Date;
}): PasskeySignerRow {
  return {
    ...r,
    address: getAddress(r.address),
    publicKeyX: r.publicKeyX as Hex,
    publicKeyY: r.publicKeyY as Hex,
    verifiers: r.verifiers as Hex,
  };
}

/** The member's current (not replaced) signing passkey for this fund. */
export async function findActivePasskeySigner(
  fundId: string,
  userId: string,
): Promise<PasskeySignerRow | null> {
  const row = await prisma.fundPasskeySigner.findFirst({
    where: { fundId, userId, replacedAt: null },
    orderBy: { createdAt: "desc" },
    select: passkeySignerSelect,
  });
  return row ? toRow(row) : null;
}

export async function findPasskeySignerById(
  fundId: string,
  id: string,
): Promise<PasskeySignerRow | null> {
  const row = await prisma.fundPasskeySigner.findFirst({
    where: { id, fundId },
    select: passkeySignerSelect,
  });
  return row ? toRow(row) : null;
}

/** Active signing passkeys of several members, keyed by user id. */
export async function activePasskeySignersByUser(
  fundId: string,
  userIds: string[],
): Promise<Map<string, PasskeySignerRow>> {
  if (userIds.length === 0) return new Map();
  const rows = await prisma.fundPasskeySigner.findMany({
    where: { fundId, userId: { in: userIds }, replacedAt: null },
    orderBy: { createdAt: "asc" },
    select: passkeySignerSelect,
  });
  const out = new Map<string, PasskeySignerRow>();
  for (const r of rows) out.set(r.userId, toRow(r)); // latest wins
  return out;
}

/**
 * Make sure the signer proxy exists on chain (deploying it through the
 * relayer when it does not) and record that on the row. Called at
 * registration and again, defensively, before a Safe lists the address as
 * an owner.
 */
export async function ensurePasskeySignerDeployed(
  row: PasskeySignerRow,
  chainId: number,
): Promise<PasskeySignerRow> {
  if (row.deployedAt && (await hasContractCode(chainId, row.address))) return row;
  if (!isRelayerConfigured()) {
    throw new SafeError("relayer_not_configured", "Safe relayer is not configured");
  }
  const { address, txHash } = await deployPasskeySigner({
    chainId,
    x: BigInt(row.publicKeyX),
    y: BigInt(row.publicKeyY),
    verifiers: BigInt(row.verifiers),
  });
  if (getAddress(address) !== row.address) {
    throw new SafeError(
      "invalid_state",
      `Signer deployed at ${address} but the row expected ${row.address}`,
    );
  }
  const updated = await prisma.fundPasskeySigner.update({
    where: { id: row.id },
    data: {
      deployedAt: new Date(),
      ...(txHash !== "0x" ? { deployTxHash: txHash } : {}),
    },
    select: passkeySignerSelect,
  });
  return toRow(updated);
}

// ---------------------------------------------------------------------------
// Registration ceremony
// ---------------------------------------------------------------------------

type ChallengeRecord = {
  challenge: string; // base64url
  fundId: string;
  userId: string;
  replace: boolean;
};

// Refuse a replacement that would pile up: a previous replacement still
// owning an unarchived Safe (swap pending), or too many registrations today.
async function assertReplacementAllowed(fundId: string, userId: string): Promise<void> {
  const [pendingSwaps, recent] = await Promise.all([
    prisma.fundSafeOwner.count({
      where: {
        removedAt: null,
        safe: { fundId, archivedAt: null },
        passkey: { is: { fundId, userId, replacedAt: { not: null } } },
      },
    }),
    prisma.fundPasskeySigner.count({
      where: { fundId, userId, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
  ]);
  const refusal = replacementRefusal(pendingSwaps, recent, MAX_REGISTRATIONS_PER_DAY);
  if (refusal === "passkey_replace_pending") {
    throw new SafeError(refusal, "A previous passkey of yours still owns a Safe: finish its swap first");
  }
  if (refusal === "passkey_rate_limited") {
    throw new SafeError(refusal, "Too many signing passkeys registered today");
  }
}

export async function beginSigningPasskeyRegistration(a: {
  fund: { id: string; name: string };
  user: { id: string; email: string };
  rpID: string;
  replace: boolean;
}): Promise<{ challengeId: string; options: ReturnType<typeof signingPasskeyRegistrationOptions> }> {
  const active = await findActivePasskeySigner(a.fund.id, a.user.id);
  if (active && !a.replace) {
    throw new SafeError("passkey_exists", "You already have a signing passkey for this fund");
  }
  if (a.replace) await assertReplacementAllowed(a.fund.id, a.user.id);
  const challenge = randomBytes(32);
  const challengeId = toHex(randomBytes(16)).slice(2);
  const record: ChallengeRecord = {
    challenge: Buffer.from(challenge).toString("base64url"),
    fundId: a.fund.id,
    userId: a.user.id,
    replace: a.replace,
  };
  await prisma.verification.create({
    data: {
      identifier: `${CHALLENGE_PREFIX}${challengeId}`,
      value: JSON.stringify(record),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
  // Nothing is excluded: without `replace` an active credential already
  // refused above, and a replacement must stay possible on the very device
  // that still holds the old credential (a lost device can't answer anyway).
  const options = signingPasskeyRegistrationOptions({
    rpID: a.rpID,
    fundId: a.fund.id,
    fundName: a.fund.name,
    userId: a.user.id,
    email: a.user.email,
    challenge,
    excludeCredentialIds: [],
  });
  return { challengeId, options };
}

async function consumeChallenge(challengeId: string): Promise<ChallengeRecord> {
  if (!/^[0-9a-f]{32}$/.test(challengeId)) {
    throw new SafeError("invalid_state", "Unknown registration challenge");
  }
  const identifier = `${CHALLENGE_PREFIX}${challengeId}`;
  const row = await prisma.verification.findFirst({
    where: { identifier },
    select: { id: true, value: true, expiresAt: true },
  });
  if (!row) throw new SafeError("invalid_state", "Unknown registration challenge");
  // Single use: whoever deletes the row owns it.
  const gone = await prisma.verification.deleteMany({ where: { id: row.id, identifier } });
  if (gone.count === 0) throw new SafeError("invalid_state", "Registration challenge already used");
  if (row.expiresAt.getTime() < Date.now()) {
    throw new SafeError("invalid_state", "Registration challenge expired");
  }
  let record: ChallengeRecord;
  try {
    record = JSON.parse(row.value) as ChallengeRecord;
  } catch {
    throw new SafeError("invalid_state", "Registration challenge is corrupt");
  }
  return record;
}

/**
 * Verify the browser's registration response, derive the signer contract
 * address, store the row and deploy the proxy. The row is written before
 * the deployment so a relayer hiccup leaves a retryable row (deployedAt
 * null): `ensurePasskeySignerDeployed` finishes it on next use.
 */
export async function finishSigningPasskeyRegistration(a: {
  fundId: string;
  userId: string;
  chainId: number;
  challengeId: string;
  response: RegistrationResponseJSON;
  expectedOrigin: string | string[];
  rpID: string;
}): Promise<{ row: PasskeySignerRow; deployed: boolean; deployError: string | null }> {
  const record = await consumeChallenge(a.challengeId);
  if (record.fundId !== a.fundId || record.userId !== a.userId) {
    throw new SafeError("invalid_state", "Registration challenge belongs to someone else");
  }
  if (record.replace) await assertReplacementAllowed(a.fundId, a.userId);
  const verified = await verifySigningRegistration({
    response: a.response,
    expectedChallenge: record.challenge,
    expectedOrigin: a.expectedOrigin,
    rpID: a.rpID,
  });

  const verifiers = passkeyVerifiersFor(a.chainId);
  const address = await predictPasskeySignerAddress({
    chainId: a.chainId,
    x: BigInt(verified.x),
    y: BigInt(verified.y),
    verifiers,
  });

  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    const active = await tx.fundPasskeySigner.findMany({
      where: { fundId: a.fundId, userId: a.userId, replacedAt: null },
      select: { id: true },
    });
    if (active.length > 0 && !record.replace) {
      throw new SafeError("passkey_exists", "You already have a signing passkey for this fund");
    }
    if (active.length > 0) {
      await tx.fundPasskeySigner.updateMany({
        where: { id: { in: active.map((r) => r.id) } },
        data: { replacedAt: now },
      });
    }
    return tx.fundPasskeySigner.create({
      data: {
        fundId: a.fundId,
        userId: a.userId,
        address,
        credentialId: verified.credentialId,
        publicKeyX: verified.x,
        publicKeyY: verified.y,
        verifiers: toHex(verifiers, { size: 22 }),
        backupEligible: verified.backupEligible,
        backupState: verified.backupState,
        transports: verified.transports,
        aaguid: verified.aaguid,
      },
      select: passkeySignerSelect,
    });
  });

  let row = toRow(created);
  try {
    row = await ensurePasskeySignerDeployed(row, a.chainId);
    return { row, deployed: true, deployError: null };
  } catch (e) {
    console.error("[safe] passkey signer deployment failed", row.id, e);
    return {
      row,
      deployed: false,
      deployError: isSafeError(e) ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Signing ceremony (server side)
// ---------------------------------------------------------------------------

/** The challenge a signing ceremony for `safeTxHash` must carry. */
export function signingChallenge(safeTxHash: Hex): string {
  return challengeForHash(safeTxHash);
}

/**
 * Verify a member's assertion over a safeTxHash against their row (origin,
 * rpID, user verification, P-256 signature) and record the ceremony's
 * counter and backup flags. Returns the module signature parts.
 */
export async function verifyPasskeySignerAssertion(a: {
  row: PasskeySignerRow;
  safeTxHash: Hex;
  response: AuthenticationResponseJSON;
  expectedOrigin: string | string[];
  rpID: string;
}): Promise<VerifiedSigningAssertion> {
  const verified = await verifySigningAssertion({
    response: a.response,
    safeTxHash: a.safeTxHash,
    expectedOrigin: a.expectedOrigin,
    rpID: a.rpID,
    credential: {
      id: a.row.credentialId,
      x: a.row.publicKeyX,
      y: a.row.publicKeyY,
      counter: a.row.counter,
      transports: a.row.transports,
    },
  });
  try {
    await prisma.fundPasskeySigner.updateMany({
      where: { id: a.row.id, fundId: a.row.fundId },
      data: {
        counter: verified.counter,
        backupEligible: verified.backupEligible,
        backupState: verified.backupState,
        lastUsedAt: new Date(),
      },
    });
  } catch (e) {
    console.warn("[safe] passkey ceremony bookkeeping failed", a.row.id, e);
  }
  return verified;
}
