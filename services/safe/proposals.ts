// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { formatUnits, getAddress, parseUnits } from "viem";

import type { Prisma } from "@/services/db/generated/client";
import type { FundSafeTxKind } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import {
  customTokenAddress,
  enabledExtraTokens,
  isCustomTokenKey,
} from "@/services/token/extra-tokens";
import {
  ANNOTATION_KINDS,
  ANNOTATION_TRIGGERS,
  annotateTransaction,
} from "@/services/transaction-annotation/annotate";

import {
  deploySafe,
  errorTxHash,
  execSafeTransaction,
  findSafeExecution,
  isRelayerConfigured,
  readSafeState,
  verifyContractSignature,
} from "./relayer";
import { safeHoldsValue } from "./holdings";
import { checkOwnerChange, ownerRuleViolation, type RuleOwner } from "./owner-rules";
import { contractSignature } from "./passkey-signature";
import {
  activePasskeySignersByUser,
  ensurePasskeySignerDeployed,
  type PasskeySignerRow,
} from "./passkey-signers";
import { onConversionProposalGone, onConversionTxExecuted } from "@/services/convert/progress";

import {
  addOwnerWithThresholdData,
  assertAllowedOperation,
  batchCall,
  buildSafeTx,
  changeThresholdData,
  erc20TransferData,
  lc,
  packSignatures,
  randomSaltNonce,
  removeOwnerData,
  safeTxFromRow,
  safeTxHash,
  sameAddress,
  swapOwnerData,
  type SafeCall,
} from "./safe-tx";
import type {
  CreateSafeInput,
  ProposeOwnerChangeInput,
  ProposeTransferInput,
  TransferToken,
} from "./schemas";
import { redactRpcKey } from "./redact";
import { findFundSigner, signSafeTxWithSigner, type SignerRow } from "./signer";
import { syncSafe } from "./sync";
import { confirmTransaction, isTxServiceEnabled, proposeTransaction } from "./tx-service";
import {
  SafeError,
  isSafeError,
  type Address,
  type Hex,
  type OwnerMigrationReason,
  type SafeTxSummary,
} from "./types";

// Fund-parameterised core of the Safe (multisig) manager: create / deploy a
// Safe, propose transactions, collect La Caisse signatures, execute through
// the relayer once the threshold is met. Team members own their Safe key as
// a passkey (PASSKEY owners: the member's signer contract, passkey-signers.ts)
// — a passkey owner's proposal is stored unsigned and the browser's
// WebAuthn assertion is turned into a contract signature right after
// (`signTransactionWithPasskey`); a legacy server-held key (MEMBER owner,
// signer.ts) still signs server-side on the Safes that list it, until the
// migration (migration.ts) swapped it out. New Safes and new team owners
// are passkeys only. No auth here — callers pass the
// fund from the host (services/safe/admin-actions.ts via requireFundRole, or
// the cron via the safe row it iterates). Every read of a safe / transaction
// is scoped by that fund: `fundSafe.findFirst({ id, fundId })`, transactions
// through `safe: { fundId }`. No revalidatePath here (cron-safe); the actions
// layer revalidates.
//
// Tx-service calls (Safe{Wallet} mirror) are best-effort everywhere: a
// failure never fails a proposal / signature, but it is kept on the row
// (`errorMessage`, prefix `tx_service:`) so the card says the external
// owners can't see it yet; sync's re-propose clears it.

export type ProposeResult = {
  transactionId: string;
  safeTxHash: Hex;
  executed: boolean;
  txHash: Hex | null;
  // True when the proposer is a passkey owner: the proposal carries no
  // signature yet and the browser must run the signing ceremony next.
  awaitingSignature: boolean;
};

export type TryExecuteReason =
  | "threshold"
  | "relayer_not_configured"
  | "not_pending"
  | "config" // configuration drift (FundSafe.configWarning) — see sync.ts
  // Queued behind an earlier nonce (or the nonce is already consumed on
  // chain — sync settles that). Not in the original contract; it saves a
  // guaranteed-revert relayer tx.
  | "nonce";

const ADMIN_ROLES = ["ADMIN", "OWNER"] as const;

// The fund columns the token paths need (fund token + display tokens).
export type TransferFund = {
  id: string;
  tokenChainId: number;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  tokenSymbol: string | null;
  showNativeBalance: boolean;
  showEureBalance: boolean;
};
const OWNER_CHANGE_KINDS: FundSafeTxKind[] = [
  "ADD_OWNER",
  "REMOVE_OWNER",
  "SWAP_OWNER",
  "CHANGE_THRESHOLD",
];
// A DEPLOYING row older than this is considered crashed and may be retried.
const STALE_DEPLOYING_MS = 5 * 60 * 1000;

// Open-proposal caps (review S9): one owner can't queue unlimited
// transactions that each need a full-threshold rejection to clear.
export const MAX_OPEN_PROPOSALS_PER_SAFE = 20;
export const MAX_OPEN_PROPOSALS_PER_PROPOSER = 5;

/**
 * The lowest nonce ≥ the chain nonce that no open transaction uses, so a
 * withdrawn or superseded slot is reused instead of pushing every new
 * proposal behind the highest open one. Pure (review S9).
 */
export function lowestFreeNonce(chainNonce: number, openNonces: Iterable<number>): number {
  const used = new Set(openNonces);
  let n = chainNonce;
  while (used.has(n)) n++;
  return n;
}

// Canonical owner order for deployment (ascending address). Deterministic so
// a retry with the stored saltNonce predicts the same CREATE2 address and
// deploySafe's idempotency catches a deployment that did land.
function sortAddresses(addresses: Address[]): Address[] {
  return [...addresses].sort((x, y) => (lc(x) < lc(y) ? -1 : lc(x) > lc(y) ? 1 : 0));
}

function errorMessageOf(e: unknown): string {
  if (isSafeError(e)) return redactRpcKey(`${e.code}: ${e.message}`);
  return redactRpcKey(e instanceof Error ? e.message : String(e));
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "P2002";
}

function userLabel(u: { name: string | null; email: string } | null | undefined): string | null {
  if (!u) return null;
  return u.name?.trim() || u.email || null;
}

// Fund staff eligible to own a Safe with their passkey: ADMIN or OWNER of THIS fund.
async function requireAdminMembers(fundId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const rows = await prisma.fundMember.findMany({
    where: { fundId, userId: { in: userIds }, role: { in: [...ADMIN_ROLES] } },
    select: { userId: true },
  });
  const found = new Set(rows.map((r) => r.userId));
  const missing = userIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new SafeError("invalid_state", "Owner is not an admin of this fund");
  }
}

// Recovery rules (owner-rules.ts) for any Safe with team owners. A new Safe
// must comply; a change to an existing Safe must not move it further from
// the rules (a legacy 1-of-1 may still swap its server key for a passkey,
// add an owner, or raise its threshold — anything that repairs it).
function ruleError(violation: NonNullable<ReturnType<typeof ownerRuleViolation>>): SafeError {
  return new SafeError(
    violation,
    violation === "rules_spare_owner"
      ? "Keep at least one owner more than the threshold"
      : "One person's keys alone must not meet the threshold",
  );
}

function requireOwnerRules(owners: RuleOwner[], threshold: number): void {
  const violation = ownerRuleViolation(owners, threshold);
  if (violation) throw ruleError(violation);
}

function requireOwnerChangeRules(
  before: { owners: RuleOwner[]; threshold: number },
  after: { owners: RuleOwner[]; threshold: number },
): void {
  const check = checkOwnerChange(before, after);
  if (!check.ok) throw ruleError(check.violation);
}

// ---------------------------------------------------------------------------
// Safe lifecycle
// ---------------------------------------------------------------------------

// Deployment model: the FundSafe row is created FIRST (status DEPLOYING,
// address placeholder `pending:<saltNonce>`, owner rows written) so a crash
// mid-deployment leaves a row the UI can show and retry. deploySafe then
// predicts + deploys; on success the row flips to ACTIVE with the real
// address, on failure to FAILED with the error. Worker A's relayer does not
// expose prediction on its own, hence the placeholder; `retrySafeDeployment`
// re-runs deploySafe with the stored saltNonce + owner set + threshold (owners
// sorted canonically, so the CREATE2 address is stable across retries) and
// fills the address in. When deployment fails this function still throws (the
// row is kept as FAILED) so the caller can surface the error.
export async function createSafe(a: {
  fund: { id: string; tokenChainId: number };
  userId: string;
  input: CreateSafeInput;
}): Promise<{ safeId: string }> {
  const { fund, input } = a;

  const memberUserIds = [...input.memberUserIds];
  if (new Set(memberUserIds).size !== memberUserIds.length) {
    throw new SafeError("invalid_state", "Duplicate owner");
  }
  await requireAdminMembers(fund.id, memberUserIds);

  if (!isRelayerConfigured()) {
    throw new SafeError("relayer_not_configured", "Safe relayer is not configured");
  }

  // Team owners are their passkey signer contracts — never a server-held
  // key. Every selected member must have registered one for this fund, and
  // the proxy must be on chain before the Safe lists it.
  const passkeyOwners: { address: Address; passkeyId: string; userId: string }[] = [];
  const passkeys = await activePasskeySignersByUser(fund.id, memberUserIds);
  for (const userId of memberUserIds) {
    const row = passkeys.get(userId);
    if (!row) {
      throw new SafeError("passkey_missing", "A team owner has no signing passkey for this fund");
    }
    const deployed = await ensurePasskeySignerDeployed(row, fund.tokenChainId);
    passkeyOwners.push({ address: deployed.address, passkeyId: deployed.id, userId });
  }

  const externalOwners: { address: Address; label: string | null }[] = [];
  for (const ext of input.externalOwners) {
    let address: Address;
    try {
      address = getAddress(ext.address);
    } catch {
      throw new SafeError("invalid_state", "Invalid owner address");
    }
    externalOwners.push({ address, label: ext.label?.trim() || null });
  }

  const all = [...passkeyOwners.map((o) => o.address), ...externalOwners.map((o) => o.address)];
  if (new Set(all.map(lc)).size !== all.length) {
    throw new SafeError("invalid_state", "Duplicate owner");
  }
  if (all.length === 0 || input.threshold < 1 || input.threshold > all.length) {
    throw new SafeError("invalid_state", "Threshold must be between 1 and the number of owners");
  }
  requireOwnerRules(
    [
      ...passkeyOwners.map((o): RuleOwner => ({ kind: "PASSKEY", personId: o.userId })),
      ...externalOwners.map((): RuleOwner => ({ kind: "EXTERNAL", personId: null })),
    ],
    input.threshold,
  );

  const saltNonce = randomSaltNonce();
  const safe = await prisma.fundSafe.create({
    data: {
      fundId: fund.id,
      name: input.name,
      chainId: fund.tokenChainId,
      saltNonce: saltNonce.toString(),
      address: `pending:${saltNonce.toString()}`,
      threshold: input.threshold,
      status: "DEPLOYING",
      createdById: a.userId,
      owners: {
        create: [
          ...passkeyOwners.map((o) => ({
            address: o.address,
            kind: "PASSKEY" as const,
            passkeyId: o.passkeyId,
            label: null,
          })),
          ...externalOwners.map((o) => ({
            address: o.address,
            kind: "EXTERNAL" as const,
            label: o.label,
          })),
        ],
      },
    },
    select: { id: true },
  });

  await deployAndActivate({
    safeId: safe.id,
    chainId: fund.tokenChainId,
    owners: sortAddresses(all),
    threshold: input.threshold,
    saltNonce,
  });
  return { safeId: safe.id };
}

async function deployAndActivate(a: {
  safeId: string;
  chainId: number;
  owners: Address[];
  threshold: number;
  saltNonce: bigint;
}): Promise<void> {
  try {
    const { address, txHash } = await deploySafe({
      chainId: a.chainId,
      owners: a.owners,
      threshold: a.threshold,
      saltNonce: a.saltNonce,
    });
    await prisma.fundSafe.update({
      where: { id: a.safeId },
      data: {
        status: "ACTIVE",
        address: getAddress(address),
        // "0x" = already deployed by an earlier attempt (nothing sent now).
        deployTxHash: txHash && txHash !== "0x" ? txHash : undefined,
        errorMessage: null,
        lastSyncedAt: new Date(),
      },
    });
  } catch (e) {
    console.error("[safe] deployment failed", a.safeId, e);
    // Keep the broadcast hash (receipt timeout) so the attempt stays traceable.
    const sent = errorTxHash(e);
    await prisma.fundSafe.update({
      where: { id: a.safeId },
      data: {
        status: "FAILED",
        errorMessage: errorMessageOf(e),
        ...(sent ? { deployTxHash: sent } : {}),
      },
    });
    throw e;
  }
}

export async function retrySafeDeployment(a: { fundId: string; safeId: string }): Promise<void> {
  if (!isRelayerConfigured()) {
    throw new SafeError("relayer_not_configured", "Safe relayer is not configured");
  }
  // Guarded claim: FAILED, or a DEPLOYING row that has been stuck long enough
  // to be a crashed attempt. A concurrent retry gets count 0.
  const claim = await prisma.fundSafe.updateMany({
    where: {
      id: a.safeId,
      fundId: a.fundId,
      archivedAt: null,
      OR: [
        { status: "FAILED" },
        { status: "DEPLOYING", updatedAt: { lt: new Date(Date.now() - STALE_DEPLOYING_MS) } },
      ],
    },
    data: { status: "DEPLOYING", errorMessage: null },
  });
  if (claim.count === 0) {
    const exists = await prisma.fundSafe.findFirst({
      where: { id: a.safeId, fundId: a.fundId },
      select: { id: true },
    });
    if (!exists) throw new SafeError("not_found", "Safe not found");
    throw new SafeError("invalid_state", "Safe is not awaiting deployment");
  }

  const safe = await prisma.fundSafe.findFirst({
    where: { id: a.safeId, fundId: a.fundId },
    include: { owners: { where: { removedAt: null } } },
  });
  if (!safe) throw new SafeError("not_found", "Safe not found");

  await deployAndActivate({
    safeId: safe.id,
    chainId: safe.chainId,
    owners: sortAddresses(safe.owners.map((o) => getAddress(o.address))),
    threshold: safe.threshold,
    saltNonce: BigInt(safe.saltNonce),
  });
}

// Review S7: renaming or archiving a Safe is for someone who answers for it
// — a current owner (their signer is on it) or a fund OWNER — not any ADMIN.
async function requireSafeSteward(a: {
  fundId: string;
  safeId: string;
  userId: string;
  isFundOwner: boolean;
}): Promise<void> {
  if (a.isFundOwner) return;
  const owner = await prisma.fundSafeOwner.findFirst({
    where: {
      safeId: a.safeId,
      removedAt: null,
      safe: { fundId: a.fundId },
      OR: [
        { passkey: { is: { userId: a.userId } } },
        { signer: { is: { userId: a.userId } } },
      ],
    },
    select: { id: true },
  });
  if (!owner) throw new SafeError("not_owner", "Only an owner of this Safe or a fund owner can do this");
}

export async function renameSafe(a: {
  fundId: string;
  safeId: string;
  name: string;
  userId: string;
  isFundOwner: boolean;
}): Promise<void> {
  const safe = await prisma.fundSafe.findFirst({
    where: { id: a.safeId, fundId: a.fundId, archivedAt: null },
    select: { id: true },
  });
  if (!safe) throw new SafeError("not_found", "Safe not found");
  await requireSafeSteward(a);
  await prisma.fundSafe.updateMany({
    where: { id: a.safeId, fundId: a.fundId, archivedAt: null },
    data: { name: a.name },
  });
}

/**
 * Archive hides the Safe from La Caisse; the Safe stays on chain. Team
 * members can no longer sign from here, so (review S7) it is refused while
 * transactions are open and — unless the external owners alone can reach the
 * threshold — while the Safe still holds value: archiving a team-only Safe
 * with a balance would strand that balance. Reversible with
 * `unarchiveSafe`.
 */
export async function archiveSafe(a: {
  fund: TransferFund;
  safeId: string;
  userId: string;
  isFundOwner: boolean;
}): Promise<void> {
  const safe = await prisma.fundSafe.findFirst({
    where: { id: a.safeId, fundId: a.fund.id, archivedAt: null },
    select: {
      id: true,
      chainId: true,
      address: true,
      threshold: true,
      status: true,
      owners: { where: { removedAt: null }, select: { kind: true } },
    },
  });
  if (!safe) throw new SafeError("not_found", "Safe not found");
  await requireSafeSteward({ fundId: a.fund.id, safeId: safe.id, userId: a.userId, isFundOwner: a.isFundOwner });
  const open = await prisma.fundSafeTransaction.count({
    where: { safeId: safe.id, safe: { fundId: a.fund.id }, status: { in: ["PENDING", "EXECUTING"] } },
  });
  if (open > 0) {
    throw new SafeError("invalid_state", "Safe has pending transactions");
  }
  const externals = safe.owners.filter((o) => o.kind === "EXTERNAL").length;
  const membersNeeded = externals < safe.threshold;
  if (membersNeeded && safe.status === "ACTIVE") {
    const holds = await safeHoldsValue(a.fund, { chainId: safe.chainId, address: safe.address });
    if (holds === null) {
      throw new SafeError("relayer_failed", "Could not read the Safe's balances");
    }
    if (holds) throw new SafeError("holds_value", "Safe still holds funds that only team members can move");
  }
  await prisma.fundSafe.updateMany({
    where: { id: safe.id, fundId: a.fund.id, archivedAt: null },
    data: { archivedAt: new Date() },
  });
}

export async function unarchiveSafe(a: {
  fundId: string;
  safeId: string;
  userId: string;
  isFundOwner: boolean;
}): Promise<void> {
  const safe = await prisma.fundSafe.findFirst({
    where: { id: a.safeId, fundId: a.fundId, archivedAt: { not: null } },
    select: { id: true },
  });
  if (!safe) throw new SafeError("not_found", "Safe not found");
  await requireSafeSteward(a);
  await prisma.fundSafe.updateMany({
    where: { id: safe.id, fundId: a.fundId },
    // Force a sync on the next view: owners / threshold may have moved while
    // it was out of sight.
    data: { archivedAt: null, lastSyncedAt: null },
  });
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

const ownerInclude = {
  owners: {
    where: { removedAt: null },
    include: {
      signer: { include: { user: { select: { name: true, email: true } } } },
      passkey: { include: { user: { select: { name: true, email: true } } } },
    },
  },
} satisfies Prisma.FundSafeInclude;

export type LoadedSafe = Prisma.FundSafeGetPayload<{ include: typeof ownerInclude }>;

/** The Safe with its current owners — what a proposal needs; one read per action. */
export async function loadActiveSafe(fundId: string, safeId: string): Promise<LoadedSafe> {
  const safe = await prisma.fundSafe.findFirst({
    where: { id: safeId, fundId, archivedAt: null },
    include: ownerInclude,
  });
  if (!safe) throw new SafeError("not_found", "Safe not found");
  if (safe.status !== "ACTIVE") throw new SafeError("invalid_state", "Safe is not active");
  return safe;
}

// How the acting user owns this Safe: through their passkey signer contract
// (PASSKEY owner row of theirs), or through a legacy server-held key still
// listed as a MEMBER owner. Never creates anything: proposing / signing is
// for existing owners only. A member who is both (mid-migration) acts with
// the passkey.
type ActingOwner =
  | { kind: "PASSKEY"; address: Address; passkeyId: string }
  | { kind: "MEMBER"; address: Address; signer: SignerRow };

type OwnerRowLike = {
  address: string;
  kind: "MEMBER" | "EXTERNAL" | "PASSKEY";
  passkeyId?: string | null;
  passkey?: { userId: string; replacedAt: Date | null } | null;
};

async function requireActingOwner(
  fundId: string,
  userId: string,
  owners: OwnerRowLike[],
): Promise<ActingOwner> {
  const mine = owners.filter((o) => o.kind === "PASSKEY" && o.passkey?.userId === userId && o.passkeyId);
  // Only the ACTIVE credential signs (the browser asserts with it); a row
  // whose passkey was replaced is an owner the swap has not reached yet.
  const active = mine.find((o) => !o.passkey?.replacedAt);
  if (active) {
    return { kind: "PASSKEY", address: getAddress(active.address), passkeyId: active.passkeyId! };
  }
  const signer = await findFundSigner(fundId, userId);
  if (signer && owners.some((o) => o.kind === "MEMBER" && sameAddress(o.address, signer.address))) {
    return { kind: "MEMBER", address: signer.address, signer };
  }
  if (mine.length > 0) {
    throw new SafeError(
      "passkey_replaced",
      "Your passkey on this Safe was replaced: finish the owner swap first",
    );
  }
  throw new SafeError("not_owner", "You are not an owner of this Safe");
}

/**
 * How `userId` would act on this Safe: with a passkey, a legacy server key,
 * or not at all (null, including a replaced passkey awaiting its swap). For
 * the actions, which skip the pre-proposal step-up for passkey owners.
 */
export async function actingOwnerKind(a: {
  fundId: string;
  safeId: string;
  userId: string;
}): Promise<"PASSKEY" | "MEMBER" | null> {
  const safe = await prisma.fundSafe.findFirst({
    where: { id: a.safeId, fundId: a.fundId, archivedAt: null },
    include: ownerInclude,
  });
  if (!safe) return null;
  try {
    return (await requireActingOwner(a.fundId, a.userId, safe.owners)).kind;
  } catch {
    return null;
  }
}

function ownerLabel(safe: LoadedSafe, address: string): string | null {
  const o = safe.owners.find((x) => sameAddress(x.address, address));
  if (!o) return null;
  if (o.kind === "MEMBER") return userLabel(o.signer?.user);
  if (o.kind === "PASSKEY") return userLabel(o.passkey?.user);
  return o.label;
}

// Who is behind an owner row, for the recovery rules.
function ruleOwnerOf(o: {
  kind: "MEMBER" | "EXTERNAL" | "PASSKEY";
  signer?: { userId: string } | null;
  passkey?: { userId: string } | null;
}): RuleOwner {
  if (o.kind === "EXTERNAL") return { kind: "EXTERNAL", personId: null };
  return { kind: o.kind, personId: o.signer?.userId ?? o.passkey?.userId ?? null };
}

// Whether La Caisse publishes proposals / signatures to the public Safe
// Transaction Service. The tx-service is only needed when someone signs
// outside La Caisse (an EXTERNAL owner in Safe{Wallet}). For a team-only Safe
// it buys nothing and costs a lot: publishing partial signature sets lets
// anyone collect a full set and execute the tx themselves, bypassing La
// Caisse's own gates (sync, nonce ordering, bookkeeping). Same rule as
// `serviceOn` in sync.ts. `owners` are the current (removedAt null) rows.
function shouldMirror(chainId: number, owners: { kind: string }[]): boolean {
  return isTxServiceEnabled(chainId) && owners.some((o) => o.kind === "EXTERNAL");
}

async function nextNonce(safe: { id: string; chainId: number; address: string }): Promise<number> {
  const state = await readSafeState({ chainId: safe.chainId, safeAddress: safe.address as Address });
  const open = await prisma.fundSafeTransaction.findMany({
    where: { safeId: safe.id, status: { in: ["PENDING", "EXECUTING"] } },
    select: { nonce: true },
  });
  return lowestFreeNonce(state.nonce, open.map((t) => t.nonce));
}

// Review S9: a bounded queue per Safe and per proposer. Rejections are
// exempt — they are how a queue gets cleared.
async function requireQueueRoom(safeId: string, userId: string): Promise<void> {
  const open = await prisma.fundSafeTransaction.findMany({
    where: { safeId, status: { in: ["PENDING", "EXECUTING", "FAILED"] }, kind: { not: "REJECTION" } },
    select: { proposedById: true },
  });
  if (open.length >= MAX_OPEN_PROPOSALS_PER_SAFE) {
    throw new SafeError("queue_full", "This Safe has too many open transactions");
  }
  if (open.filter((t) => t.proposedById === userId).length >= MAX_OPEN_PROPOSALS_PER_PROPOSER) {
    throw new SafeError("queue_full", "You have too many open proposals on this Safe");
  }
}

async function propose(a: {
  fundId: string;
  safe: LoadedSafe;
  userId: string;
  kind: FundSafeTxKind;
  // `operation` 1 only for a MultiSendCallOnly batch (safe-tx.ts batchCall).
  call: { to: Address; value?: bigint; data: Hex; operation?: 0 | 1 };
  summary: SafeTxSummary;
  note?: string | null;
  nonce?: number; // REJECTION: the target's nonce
  conversionId?: string; // CONVERSION: the FundConversion this is a step of
}): Promise<ProposeResult> {
  const { safe } = a;
  const acting = await requireActingOwner(a.fundId, a.userId, safe.owners);
  const safeAddress = getAddress(safe.address);
  if (a.kind !== "REJECTION") await requireQueueRoom(safe.id, a.userId);

  const nonce = a.nonce ?? (await nextNonce(safe));
  const tx = buildSafeTx({
    to: a.call.to,
    value: a.call.value ?? BigInt(0),
    data: a.call.data,
    nonce: BigInt(nonce),
    operation: a.call.operation ?? 0,
  });
  assertAllowedOperation(safe.chainId, tx);
  const hash = safeTxHash({ chainId: safe.chainId, safeAddress, tx });
  // A legacy server key signs right here. A passkey owner's signature is a
  // WebAuthn ceremony in the browser: the row is stored without it and
  // `signTransactionWithPasskey` adds it next (the proposal is a plain
  // unsigned Safe proposal until then — withdrawable, visible to all).
  const signature =
    acting.kind === "MEMBER"
      ? await signSafeTxWithSigner(acting.signer, { chainId: safe.chainId, safeAddress, tx })
      : null;

  let created: { id: string };
  try {
    created = await prisma.fundSafeTransaction.create({
      data: {
        safeId: safe.id,
        nonce,
        kind: a.kind,
        to: tx.to,
        value: tx.value.toString(),
        data: tx.data,
        operation: tx.operation,
        conversionId: a.conversionId ?? null,
        safeTxHash: hash,
        summary: a.summary as Prisma.InputJsonValue,
        note: a.note?.trim() || null,
        proposedById: a.userId,
        // Nested create: the transaction and the proposer's signature are
        // written atomically.
        ...(signature && acting.kind === "MEMBER"
          ? {
              signatures: {
                create: {
                  ownerAddress: acting.address,
                  signature,
                  source: "LACAISSE" as const,
                  signerId: acting.signer.id,
                  userId: a.userId,
                },
              },
            }
          : {}),
      },
      select: { id: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new SafeError("invalid_state", "An identical transaction is already proposed", { cause: e });
    }
    throw e;
  }

  if (!signature) {
    // Mirrored to the Transaction Service with the first signature instead
    // (the service wants the proposer's signature with the proposal).
    return {
      transactionId: created.id,
      safeTxHash: hash,
      executed: false,
      txHash: null,
      awaitingSignature: true,
    };
  }

  const mirror = shouldMirror(safe.chainId, safe.owners);
  if (mirror) {
    try {
      await proposeTransaction({
        chainId: safe.chainId,
        safeAddress,
        tx,
        safeTxHash: hash,
        sender: acting.address,
        signature,
        origin: "La Caisse",
      });
    } catch (e) {
      await noteMirrorFailure(a.fundId, created.id, e);
    }
  }

  const exec = await tryExecute({ fundId: a.fundId, transactionId: created.id });
  return {
    transactionId: created.id,
    safeTxHash: hash,
    executed: exec.executed,
    txHash: exec.txHash,
    awaitingSignature: false,
  };
}

// What a transfer moves and how: the fund token (an ERC-20 transfer on
// Fund.tokenAddress), or one of the display tokens the fund shows next to it
// (services/token/extra-tokens.ts) — an ERC-20 for EURe and for a custom
// token the fund registered (FundDisplayToken, key `custom:<address>`), a
// plain value transfer for the chain's native coin. Refused unless the fund
// enabled / registered it.
type ResolvedTransferToken = {
  token: TransferToken;
  symbol: string | null;
  decimals: number;
  maxFractionDigits: number;
  contract: Address | null; // null = native coin
};

async function resolveTransferToken(
  fund: TransferFund,
  token: TransferToken,
): Promise<ResolvedTransferToken> {
  if (token === "fund") {
    if (!fund.tokenAddress || fund.tokenDecimals == null) {
      throw new SafeError("config", "Fund token is not configured");
    }
    return {
      token,
      symbol: fund.tokenSymbol?.trim() || null,
      decimals: fund.tokenDecimals,
      // TokenOperation.amount is Decimal(12,2): refuse precision we can't record.
      maxFractionDigits: Math.min(2, fund.tokenDecimals),
      contract: getAddress(fund.tokenAddress),
    };
  }
  if (isCustomTokenKey(token)) {
    // Must be one of THIS fund's registered tokens (stored checksummed).
    const row = await prisma.fundDisplayToken.findFirst({
      where: { fundId: fund.id, address: getAddress(customTokenAddress(token)) },
      select: { address: true, symbol: true, decimals: true },
    });
    if (!row) throw new SafeError("invalid_state", "Token not enabled");
    return {
      token,
      symbol: row.symbol,
      decimals: row.decimals,
      maxFractionDigits: row.decimals,
      contract: getAddress(row.address),
    };
  }
  const extra = enabledExtraTokens(fund).find((tok) => tok.key === token);
  if (!extra) throw new SafeError("invalid_state", "Token not enabled");
  return {
    token,
    symbol: extra.symbol,
    decimals: extra.decimals,
    maxFractionDigits: extra.decimals,
    contract: extra.address ? getAddress(extra.address) : null,
  };
}

export async function proposeTokenTransfer(a: {
  fund: TransferFund;
  safeId: string;
  userId: string;
  input: ProposeTransferInput;
}): Promise<ProposeResult> {
  const { fund, input } = a;
  const tok = await resolveTransferToken(fund, input.token ?? "fund");
  const safe = await loadActiveSafe(fund.id, a.safeId);
  // Display tokens are registered per fund chain too, so one check covers all.
  if (safe.chainId !== fund.tokenChainId) {
    throw new SafeError("unsupported_chain", "Safe and fund token are on different chains");
  }

  const fraction = input.amount.split(".")[1] ?? "";
  if (fraction.length > tok.maxFractionDigits) {
    throw new SafeError("invalid_state", "Amount has too many decimals");
  }
  let units: bigint;
  try {
    units = parseUnits(input.amount, tok.decimals);
  } catch (e) {
    throw new SafeError("invalid_state", "Invalid amount", { cause: e });
  }
  if (units <= BigInt(0)) throw new SafeError("invalid_state", "Invalid amount");

  const recipient = getAddress(input.recipient);
  return propose({
    fundId: fund.id,
    safe,
    userId: a.userId,
    kind: "TOKEN_TRANSFER",
    call: tok.contract
      ? { to: tok.contract, data: erc20TransferData(recipient, units) }
      : // Native coin: the Safe sends `value` straight to the recipient.
        { to: recipient, value: units, data: "0x" },
    summary: {
      kind: "TOKEN_TRANSFER",
      amount: formatUnits(units, tok.decimals),
      recipient,
      recipientLabel: input.recipientLabel?.trim() || null,
      token: tok.token,
      ...(tok.symbol ? { symbol: tok.symbol } : {}),
      contract: tok.contract,
    },
    note: input.note,
  });
}

/**
 * One on-chain step of a token conversion (services/convert/engine.ts): the
 * leg's calls as one Safe transaction — a MultiSendCallOnly batch when there
 * are several (operation 1, allowed to that contract only). The engine has
 * already loaded the Safe (loadActiveSafe) and checked every call against
 * the converter's contracts; the summary tells signers what moves and lists
 * the inner calls.
 */
export async function proposeConversionStep(a: {
  fund: { id: string; tokenChainId: number };
  safe: LoadedSafe;
  userId: string;
  conversionId: string;
  calls: SafeCall[];
  summary: Extract<SafeTxSummary, { kind: "CONVERSION" }>;
}): Promise<ProposeResult> {
  const { safe } = a;
  if (safe.chainId !== a.fund.tokenChainId) {
    throw new SafeError("unsupported_chain", "Safe and fund token are on different chains");
  }
  return propose({
    fundId: a.fund.id,
    safe,
    userId: a.userId,
    kind: "CONVERSION",
    call: batchCall(safe.chainId, a.calls),
    summary: a.summary,
    conversionId: a.conversionId,
  });
}

// Resolve the "new owner" of an ADD / SWAP: a fund member (ADMIN/OWNER) —
// their active passkey signer contract, deployed if need be; never a
// server-held key — or an external address with a label.
async function resolveNewOwner(
  fundId: string,
  chainId: number,
  v: { memberUserId?: string; address?: string; label?: string },
): Promise<{ address: Address; label: string | null; rule: RuleOwner; passkey: PasskeySignerRow | null }> {
  if (v.memberUserId) {
    await requireAdminMembers(fundId, [v.memberUserId]);
    const row = (await activePasskeySignersByUser(fundId, [v.memberUserId])).get(v.memberUserId);
    if (!row) {
      throw new SafeError("passkey_missing", "This member has no signing passkey for this fund");
    }
    const passkey = await ensurePasskeySignerDeployed(row, chainId);
    const user = await prisma.user.findUnique({
      where: { id: v.memberUserId },
      select: { name: true, email: true },
    });
    return {
      address: passkey.address,
      label: userLabel(user),
      rule: { kind: "PASSKEY", personId: v.memberUserId },
      passkey,
    };
  }
  if (!v.address) throw new SafeError("invalid_state", "New owner is required");
  return {
    address: getAddress(v.address),
    label: v.label?.trim() || null,
    rule: { kind: "EXTERNAL", personId: null },
    passkey: null,
  };
}

export async function proposeOwnerChange(a: {
  fund: { id: string; tokenChainId: number };
  safeId: string;
  userId: string;
  input: ProposeOwnerChangeInput;
}): Promise<ProposeResult> {
  const { fund, input } = a;
  const change = input.change;
  const safe = await loadActiveSafe(fund.id, a.safeId);
  const safeAddress = getAddress(safe.address);
  // Owner-list calldata (prevOwner) needs the on-chain getOwners() order.
  const state = await readSafeState({ chainId: safe.chainId, safeAddress });
  const chainOwners = state.owners.map((o) => getAddress(o));
  const isOwner = (addr: string) => chainOwners.some((o) => sameAddress(o, addr));
  // The owner set as the chain has it, with the person behind each row we
  // know (an address La Caisse never recorded counts as external).
  const ruleOwnerAt = (addr: Address): RuleOwner => {
    const row = safe.owners.find((o) => sameAddress(o.address, addr));
    return row ? ruleOwnerOf(row) : { kind: "EXTERNAL", personId: null };
  };
  const currentRules = chainOwners.map(ruleOwnerAt);
  const before = { owners: currentRules, threshold: state.threshold };

  let kind: FundSafeTxKind;
  let data: Hex;
  let summary: SafeTxSummary;

  switch (change.kind) {
    case "ADD_OWNER": {
      const owner = await resolveNewOwner(fund.id, safe.chainId, change);
      if (isOwner(owner.address)) throw new SafeError("invalid_state", "Already an owner");
      if (change.threshold < 1 || change.threshold > chainOwners.length + 1) {
        throw new SafeError("invalid_state", "Invalid threshold");
      }
      requireOwnerChangeRules(before, { owners: [...currentRules, owner.rule], threshold: change.threshold });
      kind = "ADD_OWNER";
      data = addOwnerWithThresholdData(owner.address, BigInt(change.threshold));
      summary = {
        kind,
        owner: owner.address,
        ownerLabel: owner.label,
        threshold: change.threshold,
        previousThreshold: state.threshold,
      };
      break;
    }
    case "REMOVE_OWNER": {
      const owner = getAddress(change.address);
      if (!isOwner(owner)) throw new SafeError("invalid_state", "Not an owner");
      if (chainOwners.length <= 1) throw new SafeError("invalid_state", "Cannot remove the last owner");
      if (change.threshold < 1 || change.threshold > chainOwners.length - 1) {
        throw new SafeError("invalid_state", "Invalid threshold");
      }
      requireOwnerChangeRules(before, {
        owners: chainOwners.filter((o) => !sameAddress(o, owner)).map(ruleOwnerAt),
        threshold: change.threshold,
      });
      kind = "REMOVE_OWNER";
      data = removeOwnerData(chainOwners, owner, BigInt(change.threshold));
      summary = {
        kind,
        owner,
        ownerLabel: ownerLabel(safe, owner),
        threshold: change.threshold,
        previousThreshold: state.threshold,
      };
      break;
    }
    case "SWAP_OWNER": {
      const oldOwner = getAddress(change.oldOwner);
      if (!isOwner(oldOwner)) throw new SafeError("invalid_state", "Not an owner");
      const next = await resolveNewOwner(fund.id, safe.chainId, change);
      if (isOwner(next.address)) throw new SafeError("invalid_state", "Already an owner");
      requireOwnerChangeRules(before, {
        owners: chainOwners.map((o) => (sameAddress(o, oldOwner) ? next.rule : ruleOwnerAt(o))),
        threshold: state.threshold,
      });
      kind = "SWAP_OWNER";
      data = swapOwnerData(chainOwners, oldOwner, next.address);
      const migration = migrationReasonFor(safe, oldOwner, next);
      summary = {
        kind,
        oldOwner,
        oldOwnerLabel: ownerLabel(safe, oldOwner),
        newOwner: next.address,
        newOwnerLabel: next.label,
        ...(migration ? { migration } : {}),
      };
      break;
    }
    case "CHANGE_THRESHOLD": {
      if (change.threshold < 1 || change.threshold > chainOwners.length) {
        throw new SafeError("invalid_state", "Invalid threshold");
      }
      if (change.threshold === state.threshold) {
        throw new SafeError("invalid_state", "Threshold unchanged");
      }
      requireOwnerChangeRules(before, { owners: currentRules, threshold: change.threshold });
      kind = "CHANGE_THRESHOLD";
      data = changeThresholdData(BigInt(change.threshold));
      summary = { kind, threshold: change.threshold, previousThreshold: state.threshold };
      break;
    }
  }

  return propose({
    fundId: fund.id,
    safe,
    userId: a.userId,
    kind,
    call: { to: safeAddress, data },
    summary,
    note: input.note,
  });
}

// A swap that moves a member's owner key to their passkey: the old owner is
// their server-held key, or their replaced (lost) passkey, and the new one
// is their active passkey signer. Recorded on the summary for the history.
function migrationReasonFor(
  safe: LoadedSafe,
  oldOwner: Address,
  next: { passkey: PasskeySignerRow | null },
): OwnerMigrationReason | null {
  if (!next.passkey) return null;
  const old = safe.owners.find((o) => sameAddress(o.address, oldOwner));
  if (!old) return null;
  if (old.kind === "MEMBER" && old.signer?.userId === next.passkey.userId) return "server_key";
  if (old.kind === "PASSKEY" && old.passkey?.userId === next.passkey.userId && old.passkey.replacedAt) {
    return "replaced_passkey";
  }
  return null;
}

// Standard Safe rejection: an empty self-call at the target's nonce. Once it
// executes the nonce is consumed and the target can never run.
export async function proposeRejection(a: {
  fund: { id: string; tokenChainId: number };
  safeId: string;
  userId: string;
  transactionId: string;
}): Promise<ProposeResult> {
  const safe = await loadActiveSafe(a.fund.id, a.safeId);
  const target = await prisma.fundSafeTransaction.findFirst({
    where: { id: a.transactionId, safeId: safe.id, safe: { fundId: a.fund.id } },
    select: { id: true, nonce: true, kind: true, status: true },
  });
  if (!target) throw new SafeError("not_found", "Transaction not found");
  if (target.kind === "REJECTION") throw new SafeError("invalid_state", "Cannot reject a rejection");
  if (target.status !== "PENDING" && target.status !== "FAILED") {
    throw new SafeError("invalid_state", "Transaction is not pending");
  }
  const existing = await prisma.fundSafeTransaction.count({
    where: {
      safeId: safe.id,
      kind: "REJECTION",
      nonce: target.nonce,
      status: { in: ["PENDING", "EXECUTING"] },
    },
  });
  if (existing > 0) throw new SafeError("invalid_state", "A rejection is already pending");

  const state = await readSafeState({ chainId: safe.chainId, safeAddress: getAddress(safe.address) });
  if (state.nonce > target.nonce) throw new SafeError("nonce", "Nonce already used on chain");

  return propose({
    fundId: a.fund.id,
    safe,
    userId: a.userId,
    kind: "REJECTION",
    call: { to: getAddress(safe.address), value: BigInt(0), data: "0x" },
    summary: { kind: "REJECTION", rejectsNonce: target.nonce },
    nonce: target.nonce,
  });
}

/**
 * Withdraw an open proposal: the row and its signatures are deleted and the
 * nonce becomes free again (nothing was executed; the Safe never saw it).
 * Allowed to the proposer, or to a fund OWNER for anyone's proposal (e.g. a
 * demoted admin's leftovers). Only PENDING / FAILED rows — an EXECUTING one
 * may be on chain. For a Safe with external owners the proposal was also
 * mirrored to the Transaction Service, where it stays visible; Safe{Wallet}
 * can still gather signatures for it there, so the dialog says so and the
 * rejection flow remains the way to kill a nonce for good (review S9).
 */
export async function withdrawProposal(a: {
  fundId: string;
  safeId: string;
  transactionId: string;
  userId: string;
  isFundOwner: boolean;
}): Promise<{ mirrored: boolean }> {
  const safe = await loadActiveSafe(a.fundId, a.safeId);
  const tx = await prisma.fundSafeTransaction.findFirst({
    where: { id: a.transactionId, safeId: safe.id, safe: { fundId: a.fundId } },
    select: { id: true, status: true, proposedById: true, kind: true, conversionId: true },
  });
  if (!tx) throw new SafeError("not_found", "Transaction not found");
  if (tx.status !== "PENDING" && tx.status !== "FAILED") {
    throw new SafeError("invalid_state", "Transaction cannot be withdrawn in its current state");
  }
  if (tx.proposedById !== a.userId && !a.isFundOwner) {
    throw new SafeError("not_owner", "Only the proposer or a fund owner can withdraw it");
  }
  const res = await prisma.fundSafeTransaction.deleteMany({
    where: {
      id: tx.id,
      safe: { fundId: a.fundId },
      status: { in: ["PENDING", "FAILED"] },
    },
  });
  if (res.count === 0) throw new SafeError("invalid_state", "Transaction already changed");
  // A conversion step withdrawn: the conversion waits to be proposed again
  // (or cancelled). Best effort — the conversions cron repairs a miss.
  if (tx.kind === "CONVERSION" && tx.conversionId) {
    try {
      await onConversionProposalGone({ fundId: a.fundId, conversionId: tx.conversionId });
    } catch (e) {
      console.error("[safe] conversion hand-back failed", tx.conversionId, e);
    }
  }
  return { mirrored: shouldMirror(safe.chainId, safe.owners) };
}

// ---------------------------------------------------------------------------
// Signing + execution
// ---------------------------------------------------------------------------

type SignableTx = NonNullable<Awaited<ReturnType<typeof loadSignableTx>>>;

async function loadSignableTx(fundId: string, transactionId: string) {
  const tx = await prisma.fundSafeTransaction.findFirst({
    where: { id: transactionId, safe: { fundId } },
    include: {
      signatures: { select: { ownerAddress: true } },
      safe: { include: ownerInclude },
    },
  });
  if (!tx) throw new SafeError("not_found", "Transaction not found");
  if (tx.status !== "PENDING") throw new SafeError("invalid_state", "Transaction is not pending");
  if (tx.safe.status !== "ACTIVE" || tx.safe.archivedAt) {
    throw new SafeError("invalid_state", "Safe is not active");
  }
  return tx;
}

// The SafeTx of a stored row, checked against its stored hash — and against
// the operation rule, so a row altered underneath us is never signed.
function checkedSafeTx(tx: SignableTx) {
  const safeAddress = getAddress(tx.safe.address);
  const safeTx = safeTxFromRow(tx);
  assertAllowedOperation(tx.safe.chainId, safeTx);
  if (lc(safeTxHash({ chainId: tx.safe.chainId, safeAddress, tx: safeTx })) !== lc(tx.safeTxHash)) {
    throw new SafeError("invalid_state", "Stored transaction does not match its hash");
  }
  return { safeAddress, safeTx };
}

/**
 * Sign with the acting user's LEGACY server-held key (MEMBER owner). A
 * passkey owner is refused here: their signature is a browser ceremony
 * (`signTransactionWithPasskey`).
 */
export async function signTransaction(a: {
  fundId: string;
  transactionId: string;
  userId: string;
}): Promise<{ executed: boolean; txHash: Hex | null }> {
  const tx = await loadSignableTx(a.fundId, a.transactionId);
  const acting = await requireActingOwner(a.fundId, a.userId, tx.safe.owners);
  if (acting.kind !== "MEMBER") {
    throw new SafeError("invalid_state", "This owner signs with a passkey");
  }
  if (tx.signatures.some((s) => sameAddress(s.ownerAddress, acting.address))) {
    throw new SafeError("already_signed", "Already signed");
  }
  const { safeAddress, safeTx } = checkedSafeTx(tx);
  const signature = await signSafeTxWithSigner(acting.signer, {
    chainId: tx.safe.chainId,
    safeAddress,
    tx: safeTx,
  });
  return storeSignatureAndExecute({
    fundId: a.fundId,
    tx,
    safeTx,
    owner: acting.address,
    signature,
    row: { source: "LACAISSE", signerId: acting.signer.id, userId: a.userId },
  });
}

/**
 * Sign as a PASSKEY owner with the signer contract's signature bytes
 * (`dynamicPart`: the module's abi-encoded WebAuthn signature, already
 * checked against the member's credential by the caller). The contract
 * itself is asked whether it accepts it — the same EIP-1271 call the Safe
 * makes — before the row is stored.
 */
export async function signTransactionWithPasskey(a: {
  fundId: string;
  transactionId: string;
  userId: string;
  dynamicPart: Hex;
}): Promise<{ executed: boolean; txHash: Hex | null; ownerAddress: Address }> {
  const tx = await loadSignableTx(a.fundId, a.transactionId);
  const acting = await requireActingOwner(a.fundId, a.userId, tx.safe.owners);
  if (acting.kind !== "PASSKEY") {
    throw new SafeError("invalid_state", "This owner signs with a server-held key");
  }
  if (tx.signatures.some((s) => sameAddress(s.ownerAddress, acting.address))) {
    throw new SafeError("already_signed", "Already signed");
  }
  const { safeTx } = checkedSafeTx(tx);
  const accepted = await verifyContractSignature({
    chainId: tx.safe.chainId,
    owner: acting.address,
    hash: tx.safeTxHash as Hex,
    signature: a.dynamicPart,
  });
  if (!accepted) {
    throw new SafeError("invalid_signature", "The signer contract rejected the passkey signature");
  }
  const res = await storeSignatureAndExecute({
    fundId: a.fundId,
    tx,
    safeTx,
    owner: acting.address,
    signature: contractSignature(acting.address, a.dynamicPart),
    row: { source: "PASSKEY", passkeyId: acting.passkeyId, userId: a.userId },
  });
  return { ...res, ownerAddress: acting.address };
}

// Store a signature, mirror it to the Transaction Service (the proposal
// itself when this is its first signature), then try to execute.
async function storeSignatureAndExecute(a: {
  fundId: string;
  tx: SignableTx;
  safeTx: ReturnType<typeof safeTxFromRow>;
  owner: Address;
  signature: Hex;
  row:
    | { source: "LACAISSE"; signerId: string; userId: string }
    | { source: "PASSKEY"; passkeyId: string; userId: string };
}): Promise<{ executed: boolean; txHash: Hex | null }> {
  const { tx } = a;
  try {
    await prisma.fundSafeSignature.create({
      data: {
        transactionId: tx.id,
        ownerAddress: a.owner,
        signature: a.signature,
        ...a.row,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new SafeError("already_signed", "Already signed", { cause: e });
    throw e;
  }

  const mirror = shouldMirror(tx.safe.chainId, tx.safe.owners);
  if (mirror) {
    try {
      if (tx.signatures.length === 0) {
        await proposeTransaction({
          chainId: tx.safe.chainId,
          safeAddress: getAddress(tx.safe.address),
          tx: a.safeTx,
          safeTxHash: tx.safeTxHash as Hex,
          sender: a.owner,
          signature: a.signature,
          origin: "La Caisse",
        });
      } else {
        await confirmTransaction({
          chainId: tx.safe.chainId,
          safeTxHash: tx.safeTxHash as Hex,
          signature: a.signature,
        });
      }
      await clearMirrorFailure(a.fundId, tx.id);
    } catch (e) {
      await noteMirrorFailure(a.fundId, tx.id, e);
    }
  }

  const exec = await tryExecute({ fundId: a.fundId, transactionId: tx.id });
  return { executed: exec.executed, txHash: exec.txHash };
}

export const MIRROR_ERROR_PREFIX = "tx_service:";

/** Keep a Transaction Service failure on the (still PENDING) row. Never throws. */
export async function noteMirrorFailure(fundId: string, transactionId: string, e: unknown): Promise<void> {
  const message = `${MIRROR_ERROR_PREFIX} ${errorMessageOf(e).replace(/^tx_service: /, "")}`.slice(0, 400);
  console.warn("[safe] tx-service mirror failed", transactionId, message);
  try {
    await prisma.fundSafeTransaction.updateMany({
      where: { id: transactionId, safe: { fundId }, status: "PENDING" },
      data: { errorMessage: message },
    });
  } catch (err) {
    console.warn("[safe] could not record mirror failure", transactionId, errorMessageOf(err));
  }
}

/** Drop a recorded mirror failure once the service has the transaction. */
export async function clearMirrorFailure(fundId: string, transactionId: string): Promise<void> {
  try {
    await prisma.fundSafeTransaction.updateMany({
      where: { id: transactionId, safe: { fundId }, errorMessage: { startsWith: MIRROR_ERROR_PREFIX } },
      data: { errorMessage: null },
    });
  } catch (err) {
    console.warn("[safe] could not clear mirror failure", transactionId, errorMessageOf(err));
  }
}

// Execute when the threshold is met. Returns a reason (not an error) for the
// "not yet" outcomes. When the relayer tx fails the row is marked FAILED
// (signatures kept, retryable) and the SafeError is rethrown so the caller can
// surface it. After a success it refreshes owners/threshold (owner changes) and
// tries the next nonce; `fromSync` skips both because syncSafe does them itself
// (owners refreshed at the end, transactions walked in nonce order).
export async function tryExecute(a: {
  fundId: string;
  transactionId: string;
  fromSync?: boolean;
}): Promise<{ executed: boolean; txHash: Hex | null; reason: TryExecuteReason | null }> {
  const tx = await prisma.fundSafeTransaction.findFirst({
    where: { id: a.transactionId, safe: { fundId: a.fundId } },
    include: {
      signatures: true,
      safe: { include: { owners: { where: { removedAt: null } } } },
    },
  });
  if (!tx) throw new SafeError("not_found", "Transaction not found");
  if (tx.status !== "PENDING") return { executed: false, txHash: null, reason: "not_pending" };

  const { safe } = tx;
  // Never execute a DelegateCall to anything but MultiSendCallOnly, whatever
  // signatures the row has gathered (sync imports Safe{Wallet} confirmations).
  assertAllowedOperation(safe.chainId, tx);
  const safeAddress = getAddress(safe.address);
  // Readiness comes from the chain, not the owner / threshold cache: a
  // threshold or owner changed in Safe{Wallet} must not stall or revert us.
  const state = await readSafeState({ chainId: safe.chainId, safeAddress });
  const owners = new Set(
    (state.deployed ? state.owners : safe.owners.map((o) => o.address)).map(lc),
  );
  const threshold = state.deployed ? state.threshold : safe.threshold;
  const valid = tx.signatures.filter((s) => owners.has(lc(s.ownerAddress)));
  if (threshold < 1 || valid.length < threshold) {
    return { executed: false, txHash: null, reason: "threshold" };
  }
  if (!isRelayerConfigured()) {
    return { executed: false, txHash: null, reason: "relayer_not_configured" };
  }
  if (state.nonce !== tx.nonce) return { executed: false, txHash: null, reason: "nonce" };
  // A Safe whose configuration drifted from canonical 1.4.1 (a module, a
  // guard, another singleton — review S6) is shown, never driven: the
  // relayer stops executing until sync sees it clean again.
  if (safe.configWarning) return { executed: false, txHash: null, reason: "config" };

  const claim = await prisma.fundSafeTransaction.updateMany({
    where: { id: tx.id, safe: { fundId: a.fundId }, status: "PENDING" },
    data: { status: "EXECUTING", errorMessage: null },
  });
  if (claim.count === 0) return { executed: false, txHash: null, reason: "not_pending" };

  // Exactly `threshold` signatures, in ascending owner order (packSignatures
  // sorts; we pick the first `threshold` of that same order).
  const chosen = [...valid]
    .sort((x, y) => (lc(x.ownerAddress) < lc(y.ownerAddress) ? -1 : 1))
    .slice(0, threshold);

  let txHash: Hex;
  try {
    const signatures = packSignatures(
      chosen.map((s) => ({ owner: getAddress(s.ownerAddress), signature: s.signature as Hex })),
    );
    ({ txHash } = await execSafeTransaction({
      chainId: safe.chainId,
      safeAddress,
      tx: safeTxFromRow(tx),
      signatures,
      // Persist the broadcast hash before the receipt wait (review S15): a
      // timeout or crash then still leaves the hash on the EXECUTING row.
      onBroadcast: async (sent) => {
        await prisma.fundSafeTransaction.updateMany({
          where: { id: tx.id, safe: { fundId: a.fundId }, status: "EXECUTING" },
          data: { txHash: sent },
        });
      },
    }));
  } catch (e) {
    console.error("[safe] execution failed", tx.id, errorMessageOf(e));
    const sent = errorTxHash(e);
    // Nothing reached the chain (relayer nonce race, RPC hiccup, estimate
    // failure): the proposal is still perfectly executable, so hand it back
    // to PENDING for the next attempt instead of parking it as FAILED.
    const transient = !sent && isSafeError(e) && e.code === "relayer_failed";
    await prisma.fundSafeTransaction.updateMany({
      where: { id: tx.id, safe: { fundId: a.fundId }, status: "EXECUTING" },
      data: transient
        ? { status: "PENDING", errorMessage: errorMessageOf(e) }
        : { status: "FAILED", errorMessage: errorMessageOf(e), txHash: sent ?? null },
    });
    throw e;
  }

  // The tx is on chain: bookkeeping failures are logged, never turned into
  // FAILED (sync re-detects the execution through the tx-service).
  try {
    await recordExecuted({
      fundId: a.fundId,
      transactionId: tx.id,
      txHash,
      executedBy: "relayer",
      executedAt: new Date(),
    });
  } catch (e) {
    console.error("[safe] executed but bookkeeping failed", tx.id, txHash, e);
  }

  if (a.fromSync) return { executed: true, txHash, reason: null };

  if (OWNER_CHANGE_KINDS.includes(tx.kind)) {
    try {
      await syncSafe({ fundId: a.fundId, safeId: safe.id, force: true });
    } catch (e) {
      console.warn("[safe] post-execution sync failed", safe.id, e);
    }
  }

  // The next nonce may have been waiting on this one.
  const next = await prisma.fundSafeTransaction.findFirst({
    where: { safeId: safe.id, safe: { fundId: a.fundId }, status: "PENDING", nonce: tx.nonce + 1 },
    select: { id: true },
  });
  if (next) {
    try {
      await tryExecute({ fundId: a.fundId, transactionId: next.id });
    } catch (e) {
      console.warn("[safe] follow-up execution failed", next.id, errorMessageOf(e));
    }
  }

  return { executed: true, txHash, reason: null };
}

export async function retryExecution(a: {
  fundId: string;
  transactionId: string;
}): Promise<{ executed: boolean; txHash: Hex | null }> {
  const tx = await prisma.fundSafeTransaction.findFirst({
    where: { id: a.transactionId, safe: { fundId: a.fundId } },
    include: { safe: true },
  });
  if (!tx) throw new SafeError("not_found", "Transaction not found");
  if (tx.status !== "FAILED") throw new SafeError("invalid_state", "Transaction has not failed");
  const safeAddress = getAddress(tx.safe.address);
  const state = await readSafeState({ chainId: tx.safe.chainId, safeAddress });
  if (state.nonce > tx.nonce) {
    // The nonce moved on. Maybe by this very transaction (a mined relayer tx
    // whose receipt or bookkeeping was lost): the Safe's own execution event
    // settles it without the Transaction Service.
    const seen = await findSafeExecution({
      chainId: tx.safe.chainId,
      safeAddress,
      safeTxHash: tx.safeTxHash as Hex,
    });
    if (seen?.success) {
      await recordExecuted({
        fundId: a.fundId,
        transactionId: tx.id,
        txHash: seen.txHash,
        executedBy: tx.txHash && sameAddress(tx.txHash, seen.txHash) ? "relayer" : "external",
        executedAt: new Date(),
      });
      return { executed: true, txHash: seen.txHash };
    }
    throw new SafeError("nonce", "Nonce already used on chain");
  }

  // The previous attempt's hash is kept (review S15): if that tx is still
  // in the mempool and mines after all, sync matches it; a new broadcast
  // overwrites it.
  const reset = await prisma.fundSafeTransaction.updateMany({
    where: { id: tx.id, safe: { fundId: a.fundId }, status: "FAILED" },
    data: { status: "PENDING", errorMessage: null },
  });
  if (reset.count === 0) throw new SafeError("invalid_state", "Transaction has not failed");

  const exec = await tryExecute({ fundId: a.fundId, transactionId: tx.id });
  return { executed: exec.executed, txHash: exec.txHash };
}

// ---------------------------------------------------------------------------
// Execution bookkeeping (shared with sync.ts)
// ---------------------------------------------------------------------------

// Mark a transaction EXECUTED (by our relayer or seen executed externally),
// supersede the other open transactions at the same nonce, and for a
// fund-token TOKEN_TRANSFER record the TokenOperation + annotation (xDAI /
// EURe: the annotation only); a CONVERSION step gets the annotation and
// moves its conversion on. Idempotent: a row that is already EXECUTED is
// left alone.
export async function recordExecuted(a: {
  fundId: string;
  transactionId: string;
  txHash: Hex | null;
  executedBy: "relayer" | "external";
  executedAt: Date;
}): Promise<{ recorded: boolean }> {
  const tx = await prisma.fundSafeTransaction.findFirst({
    where: { id: a.transactionId, safe: { fundId: a.fundId } },
    select: {
      id: true,
      safeId: true,
      nonce: true,
      kind: true,
      summary: true,
      note: true,
      proposedById: true,
      tokenOperationId: true,
      conversionId: true,
    },
  });
  if (!tx) throw new SafeError("not_found", "Transaction not found");

  const res = await prisma.fundSafeTransaction.updateMany({
    where: {
      id: tx.id,
      safe: { fundId: a.fundId },
      status: { in: ["PENDING", "EXECUTING", "FAILED", "SUPERSEDED"] },
    },
    data: {
      status: "EXECUTED",
      txHash: a.txHash,
      executedAt: a.executedAt,
      executedBy: a.executedBy,
      errorMessage: null,
    },
  });
  if (res.count === 0) return { recorded: false };

  await prisma.fundSafeTransaction.updateMany({
    where: {
      safeId: tx.safeId,
      safe: { fundId: a.fundId },
      nonce: tx.nonce,
      id: { not: tx.id },
      status: { in: ["PENDING", "FAILED"] },
    },
    data: { status: "SUPERSEDED" },
  });

  const summary = tx.summary as SafeTxSummary | null;
  if (tx.kind === "CONVERSION" && tx.conversionId) {
    // The batch's token movements show in the Safe's history with the same
    // trigger column as a transfer. Never throws.
    if (a.txHash) {
      await annotateTransaction({
        fundId: a.fundId,
        txHash: a.txHash,
        kind: ANNOTATION_KINDS.safeConversion,
        note: tx.note,
        trigger: ANNOTATION_TRIGGERS.safeConversion,
        triggeredByUserId: tx.proposedById,
      });
    }
    // The conversion moves on (an order is out → FILLING, a next step →
    // READY, or DONE). Best effort: the conversions cron repairs a miss.
    try {
      await onConversionTxExecuted({ fundId: a.fundId, conversionId: tx.conversionId, txHash: a.txHash });
    } catch (e) {
      console.error("[safe] conversion advance failed", tx.conversionId, e);
    }
    return { recorded: true };
  }
  if (tx.kind === "TOKEN_TRANSFER" && summary?.kind === "TOKEN_TRANSFER") {
    // TokenOperation is the fund-token ledger: xDAI / EURe / custom-token
    // transfers out of a Safe only get the annotation. A summary without `token` predates
    // multi-token transfers and moved the fund token.
    const fundToken = (summary.token ?? "fund") === "fund";
    if (fundToken && tx.tokenOperationId) return { recorded: true };
    if (fundToken) {
      try {
        const op = await prisma.tokenOperation.create({
          data: {
            fundId: a.fundId,
            type: "TRANSFER",
            account: summary.recipient,
            amount: summary.amount,
            status: "CONFIRMED",
            txHash: a.txHash,
            confirmedAt: a.executedAt,
          },
          select: { id: true },
        });
        await prisma.fundSafeTransaction.update({
          where: { id: tx.id },
          data: { tokenOperationId: op.id },
        });
      } catch (e) {
        console.error("[safe] TokenOperation record failed", tx.id, e);
      }
    }
    // We hold the mined tx hash (not a userOp hash), so annotate directly
    // rather than via resolveOrEnqueueAnnotation. Never throws.
    if (a.txHash) {
      await annotateTransaction({
        fundId: a.fundId,
        txHash: a.txHash,
        kind: ANNOTATION_KINDS.safeTransfer,
        note: tx.note,
        trigger: ANNOTATION_TRIGGERS.safeTransfer,
        triggeredByUserId: tx.proposedById,
      });
    }
  }
  return { recorded: true };
}

export function isOwnerChangeKind(kind: FundSafeTxKind): boolean {
  return OWNER_CHANGE_KINDS.includes(kind);
}
