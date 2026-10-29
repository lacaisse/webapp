// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { formatUnits, getAddress, parseUnits } from "viem";

import type { Prisma } from "@/services/db/generated/client";
import type { FundSafeTxKind } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { enabledExtraTokens } from "@/services/token/extra-tokens";
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
} from "./relayer";
import {
  addOwnerWithThresholdData,
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
} from "./safe-tx";
import type {
  CreateSafeInput,
  ProposeOwnerChangeInput,
  ProposeTransferInput,
} from "./schemas";
import { getOrCreateFundSigner, signSafeTxWithSigner } from "./signer";
import { syncSafe } from "./sync";
import { confirmTransaction, isTxServiceEnabled, proposeTransaction } from "./tx-service";
import {
  SafeError,
  isSafeError,
  type Address,
  type Hex,
  type SafeTxSummary,
} from "./types";

// Fund-parameterised core of the Safe (multisig) manager: create / deploy a
// Safe, propose transactions, collect La Caisse signatures, execute through
// the relayer once the threshold is met. No auth here — callers pass the
// fund from the host (services/safe/admin-actions.ts via requireFundRole, or
// the cron via the safe row it iterates). Every read of a safe / transaction
// is scoped by that fund: `fundSafe.findFirst({ id, fundId })`, transactions
// through `safe: { fundId }`. No revalidatePath here (cron-safe); the actions
// layer revalidates.
//
// Tx-service calls (Safe{Wallet} mirror) are best-effort everywhere: a
// failure is logged and never fails a proposal / signature.

export type ProposeResult = {
  transactionId: string;
  safeTxHash: Hex;
  executed: boolean;
  txHash: Hex | null;
};

export type TryExecuteReason =
  | "threshold"
  | "relayer_not_configured"
  | "not_pending"
  // Queued behind an earlier nonce (or the nonce is already consumed on
  // chain — sync settles that). Not in the original contract; it saves a
  // guaranteed-revert relayer tx.
  | "nonce";

const ADMIN_ROLES = ["ADMIN", "OWNER"] as const;
const OWNER_CHANGE_KINDS: FundSafeTxKind[] = [
  "ADD_OWNER",
  "REMOVE_OWNER",
  "SWAP_OWNER",
  "CHANGE_THRESHOLD",
];
// A DEPLOYING row older than this is considered crashed and may be retried.
const STALE_DEPLOYING_MS = 5 * 60 * 1000;

// Canonical owner order for deployment (ascending address). Deterministic so
// a retry with the stored saltNonce predicts the same CREATE2 address and
// deploySafe's idempotency catches a deployment that did land.
function sortAddresses(addresses: Address[]): Address[] {
  return [...addresses].sort((x, y) => (lc(x) < lc(y) ? -1 : lc(x) > lc(y) ? 1 : 0));
}

function errorMessageOf(e: unknown): string {
  if (isSafeError(e)) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "P2002";
}

function userLabel(u: { name: string | null; email: string } | null | undefined): string | null {
  if (!u) return null;
  return u.name?.trim() || u.email || null;
}

// Fund staff eligible to hold a member signer key: ADMIN or OWNER of THIS fund.
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

  // Sequential: getOrCreateFundSigner inserts on first use.
  const memberOwners: { address: Address; signerId: string }[] = [];
  for (const userId of memberUserIds) {
    const signer = await getOrCreateFundSigner(fund.id, userId);
    memberOwners.push({ address: getAddress(signer.address), signerId: signer.id });
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

  const all = [...memberOwners.map((o) => o.address), ...externalOwners.map((o) => o.address)];
  if (new Set(all.map(lc)).size !== all.length) {
    throw new SafeError("invalid_state", "Duplicate owner");
  }
  if (all.length === 0 || input.threshold < 1 || input.threshold > all.length) {
    throw new SafeError("invalid_state", "Threshold must be between 1 and the number of owners");
  }

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
          ...memberOwners.map((o) => ({
            address: o.address,
            kind: "MEMBER" as const,
            signerId: o.signerId,
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

export async function renameSafe(a: { fundId: string; safeId: string; name: string }): Promise<void> {
  const res = await prisma.fundSafe.updateMany({
    where: { id: a.safeId, fundId: a.fundId, archivedAt: null },
    data: { name: a.name },
  });
  if (res.count === 0) throw new SafeError("not_found", "Safe not found");
}

export async function archiveSafe(a: { fundId: string; safeId: string }): Promise<void> {
  const safe = await prisma.fundSafe.findFirst({
    where: { id: a.safeId, fundId: a.fundId, archivedAt: null },
    select: { id: true },
  });
  if (!safe) throw new SafeError("not_found", "Safe not found");
  const open = await prisma.fundSafeTransaction.count({
    where: { safeId: safe.id, safe: { fundId: a.fundId }, status: { in: ["PENDING", "EXECUTING"] } },
  });
  if (open > 0) {
    throw new SafeError("invalid_state", "Safe has pending transactions");
  }
  await prisma.fundSafe.updateMany({
    where: { id: safe.id, fundId: a.fundId },
    data: { archivedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

const ownerInclude = {
  owners: {
    where: { removedAt: null },
    include: { signer: { include: { user: { select: { name: true, email: true } } } } },
  },
} satisfies Prisma.FundSafeInclude;

type LoadedSafe = Prisma.FundSafeGetPayload<{ include: typeof ownerInclude }>;

async function loadActiveSafe(fundId: string, safeId: string): Promise<LoadedSafe> {
  const safe = await prisma.fundSafe.findFirst({
    where: { id: safeId, fundId, archivedAt: null },
    include: ownerInclude,
  });
  if (!safe) throw new SafeError("not_found", "Safe not found");
  if (safe.status !== "ACTIVE") throw new SafeError("invalid_state", "Safe is not active");
  return safe;
}

// The acting user's signer key for this fund, which must be a current owner.
// Never creates a signer: proposing / signing is for existing owners only.
async function requireOwnerSigner(
  fundId: string,
  userId: string,
  owners: { address: string }[],
) {
  const signer = await prisma.fundSigner.findUnique({
    where: { fundId_userId: { fundId, userId } },
  });
  if (!signer || !owners.some((o) => sameAddress(o.address, signer.address))) {
    throw new SafeError("not_owner", "You are not an owner of this Safe");
  }
  return signer;
}

function ownerLabel(safe: LoadedSafe, address: string): string | null {
  const o = safe.owners.find((x) => sameAddress(x.address, address));
  if (!o) return null;
  if (o.kind === "MEMBER") return userLabel(o.signer?.user);
  return o.label;
}

async function nextNonce(safe: { id: string; chainId: number; address: string }): Promise<number> {
  const state = await readSafeState({ chainId: safe.chainId, safeAddress: safe.address as Address });
  const agg = await prisma.fundSafeTransaction.aggregate({
    where: { safeId: safe.id, status: { in: ["PENDING", "EXECUTING"] } },
    _max: { nonce: true },
  });
  const dbNext = agg._max.nonce == null ? 0 : agg._max.nonce + 1;
  return Math.max(state.nonce, dbNext);
}

async function propose(a: {
  fundId: string;
  safe: LoadedSafe;
  userId: string;
  kind: FundSafeTxKind;
  call: { to: Address; value?: bigint; data: Hex };
  summary: SafeTxSummary;
  note?: string | null;
  nonce?: number; // REJECTION: the target's nonce
}): Promise<ProposeResult> {
  const { safe } = a;
  const signer = await requireOwnerSigner(a.fundId, a.userId, safe.owners);
  const safeAddress = getAddress(safe.address);

  const nonce = a.nonce ?? (await nextNonce(safe));
  const tx = buildSafeTx({
    to: a.call.to,
    value: a.call.value ?? BigInt(0),
    data: a.call.data,
    nonce: BigInt(nonce),
  });
  const hash = safeTxHash({ chainId: safe.chainId, safeAddress, tx });
  const signature = await signSafeTxWithSigner(signer, { chainId: safe.chainId, safeAddress, tx });

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
        safeTxHash: hash,
        summary: a.summary as Prisma.InputJsonValue,
        note: a.note?.trim() || null,
        proposedById: a.userId,
        // Nested create: the transaction and the proposer's signature are
        // written atomically.
        signatures: {
          create: {
            ownerAddress: getAddress(signer.address),
            signature,
            source: "LACAISSE",
            signerId: signer.id,
            userId: a.userId,
          },
        },
      },
      select: { id: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new SafeError("invalid_state", "An identical transaction is already proposed", { cause: e });
    }
    throw e;
  }

  if (isTxServiceEnabled(safe.chainId)) {
    try {
      await proposeTransaction({
        chainId: safe.chainId,
        safeAddress,
        tx,
        safeTxHash: hash,
        sender: getAddress(signer.address),
        signature,
        origin: "La Caisse",
      });
    } catch (e) {
      console.warn("[safe] tx-service propose failed", created.id, errorMessageOf(e));
    }
  }

  const exec = await tryExecute({ fundId: a.fundId, transactionId: created.id });
  return { transactionId: created.id, safeTxHash: hash, executed: exec.executed, txHash: exec.txHash };
}

// What a transfer moves and how: the fund token (an ERC-20 transfer on
// Fund.tokenAddress), or one of the extra tokens the fund shows next to it
// (services/token/extra-tokens.ts) — an ERC-20 for EURe, a plain value
// transfer for the chain's native coin. Refused unless the fund enabled it.
type ResolvedTransferToken = {
  token: "fund" | "native" | "eure";
  symbol: string | null;
  decimals: number;
  maxFractionDigits: number;
  contract: Address | null; // null = native coin
};

function resolveTransferToken(
  fund: TransferFund,
  token: "fund" | "native" | "eure",
): ResolvedTransferToken {
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

type TransferFund = {
  id: string;
  tokenChainId: number;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  tokenSymbol: string | null;
  showNativeBalance: boolean;
  showEureBalance: boolean;
};

export async function proposeTokenTransfer(a: {
  fund: TransferFund;
  safeId: string;
  userId: string;
  input: ProposeTransferInput;
}): Promise<ProposeResult> {
  const { fund, input } = a;
  const tok = resolveTransferToken(fund, input.token ?? "fund");
  const safe = await loadActiveSafe(fund.id, a.safeId);
  // Extra tokens are registered per fund chain too, so one check covers both.
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
    },
    note: input.note,
  });
}

// Resolve the "new owner" of an ADD / SWAP: a fund member (ADMIN/OWNER — we
// create or reuse their FundSigner) or an external address with a label.
async function resolveNewOwner(
  fundId: string,
  v: { memberUserId?: string; address?: string; label?: string },
): Promise<{ address: Address; label: string | null }> {
  if (v.memberUserId) {
    await requireAdminMembers(fundId, [v.memberUserId]);
    const signer = await getOrCreateFundSigner(fundId, v.memberUserId);
    const user = await prisma.user.findUnique({
      where: { id: v.memberUserId },
      select: { name: true, email: true },
    });
    return { address: getAddress(signer.address), label: userLabel(user) };
  }
  if (!v.address) throw new SafeError("invalid_state", "New owner is required");
  return { address: getAddress(v.address), label: v.label?.trim() || null };
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

  let kind: FundSafeTxKind;
  let data: Hex;
  let summary: SafeTxSummary;

  switch (change.kind) {
    case "ADD_OWNER": {
      const owner = await resolveNewOwner(fund.id, change);
      if (isOwner(owner.address)) throw new SafeError("invalid_state", "Already an owner");
      if (change.threshold < 1 || change.threshold > chainOwners.length + 1) {
        throw new SafeError("invalid_state", "Invalid threshold");
      }
      kind = "ADD_OWNER";
      data = addOwnerWithThresholdData(owner.address, BigInt(change.threshold));
      summary = {
        kind,
        owner: owner.address,
        ownerLabel: owner.label,
        threshold: change.threshold,
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
      kind = "REMOVE_OWNER";
      data = removeOwnerData(chainOwners, owner, BigInt(change.threshold));
      summary = { kind, owner, ownerLabel: ownerLabel(safe, owner), threshold: change.threshold };
      break;
    }
    case "SWAP_OWNER": {
      const oldOwner = getAddress(change.oldOwner);
      if (!isOwner(oldOwner)) throw new SafeError("invalid_state", "Not an owner");
      const next = await resolveNewOwner(fund.id, change);
      if (isOwner(next.address)) throw new SafeError("invalid_state", "Already an owner");
      kind = "SWAP_OWNER";
      data = swapOwnerData(chainOwners, oldOwner, next.address);
      summary = {
        kind,
        oldOwner,
        oldOwnerLabel: ownerLabel(safe, oldOwner),
        newOwner: next.address,
        newOwnerLabel: next.label,
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
      kind = "CHANGE_THRESHOLD";
      data = changeThresholdData(BigInt(change.threshold));
      summary = { kind, threshold: change.threshold };
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

// ---------------------------------------------------------------------------
// Signing + execution
// ---------------------------------------------------------------------------

export async function signTransaction(a: {
  fundId: string;
  transactionId: string;
  userId: string;
}): Promise<{ executed: boolean; txHash: Hex | null }> {
  const tx = await prisma.fundSafeTransaction.findFirst({
    where: { id: a.transactionId, safe: { fundId: a.fundId } },
    include: {
      signatures: { select: { ownerAddress: true } },
      safe: { include: { owners: { where: { removedAt: null } } } },
    },
  });
  if (!tx) throw new SafeError("not_found", "Transaction not found");
  if (tx.status !== "PENDING") throw new SafeError("invalid_state", "Transaction is not pending");
  if (tx.safe.status !== "ACTIVE" || tx.safe.archivedAt) {
    throw new SafeError("invalid_state", "Safe is not active");
  }

  const signer = await requireOwnerSigner(a.fundId, a.userId, tx.safe.owners);
  if (tx.signatures.some((s) => sameAddress(s.ownerAddress, signer.address))) {
    throw new SafeError("already_signed", "Already signed");
  }

  const safeAddress = getAddress(tx.safe.address);
  const safeTx = safeTxFromRow(tx);
  if (lc(safeTxHash({ chainId: tx.safe.chainId, safeAddress, tx: safeTx })) !== lc(tx.safeTxHash)) {
    throw new SafeError("invalid_state", "Stored transaction does not match its hash");
  }
  const signature = await signSafeTxWithSigner(signer, {
    chainId: tx.safe.chainId,
    safeAddress,
    tx: safeTx,
  });

  try {
    await prisma.fundSafeSignature.create({
      data: {
        transactionId: tx.id,
        ownerAddress: getAddress(signer.address),
        signature,
        source: "LACAISSE",
        signerId: signer.id,
        userId: a.userId,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new SafeError("already_signed", "Already signed", { cause: e });
    throw e;
  }

  if (isTxServiceEnabled(tx.safe.chainId)) {
    try {
      await confirmTransaction({
        chainId: tx.safe.chainId,
        safeTxHash: tx.safeTxHash as Hex,
        signature,
      });
    } catch (e) {
      console.warn("[safe] tx-service confirm failed", tx.id, errorMessageOf(e));
    }
  }

  const exec = await tryExecute({ fundId: a.fundId, transactionId: tx.id });
  return { executed: exec.executed, txHash: exec.txHash };
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

  const reset = await prisma.fundSafeTransaction.updateMany({
    where: { id: tx.id, safe: { fundId: a.fundId }, status: "FAILED" },
    data: { status: "PENDING", errorMessage: null, txHash: null },
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
// EURe: the annotation only). Idempotent: a row
// that is already EXECUTED is left alone.
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
  if (tx.kind === "TOKEN_TRANSFER" && summary?.kind === "TOKEN_TRANSFER") {
    // TokenOperation is the fund-token ledger: xDAI / EURe transfers out of
    // a Safe only get the annotation. A summary without `token` predates
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
