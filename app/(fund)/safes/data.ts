// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";
import { getTranslations } from "next-intl/server";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import { prisma } from "@/services/db/prisma";
import type {
  FundSafeOwnerKind,
  FundSafeSignatureSource,
  FundSafeStatus,
  FundSafeTxKind,
  FundSafeTxStatus,
} from "@/services/db/generated/enums";
import {
  isRelayerConfigured,
  relayerAddress,
  relayerBalance,
} from "@/services/safe/relayer";
import type { SafeTxSummary } from "@/services/safe/types";

import { getAccountOptions } from "../accounts/data";
import { isDeployedAddress, parseSummary, shortAddress } from "./format";

// Loaders for the Safes views. cache()-wrapped so repeat reads in one render
// share a round-trip. Every query is scoped by the fund id the page got from
// requireFundRole() — a safe id from the URL is never trusted on its own.
// Balance / relayer reads degrade instead of failing the page.

type TokenContext = {
  tokenAddress: string | null;
  tokenChainId: number | null;
  tokenDecimals: number | null;
};

// Transactions still in play: collecting signatures, being executed, or
// failed and retryable.
const OPEN_STATUSES: FundSafeTxStatus[] = ["PENDING", "EXECUTING", "FAILED"];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type SafeListRow = {
  id: string;
  name: string;
  chainId: number;
  address: string;
  threshold: number;
  status: FundSafeStatus;
  errorMessage: string | null;
  ownerCount: number;
  pendingCount: number;
  balance: string | null; // human token units, null when unavailable
};

async function balancesFor(
  addresses: string[],
  token: TokenContext,
): Promise<{ byAddress: Map<string, string>; error: boolean }> {
  if (addresses.length === 0 || !token.tokenAddress || token.tokenChainId == null) {
    return { byAddress: new Map(), error: false };
  }
  try {
    const balances = await getBalances({
      chainId: token.tokenChainId,
      contractAddress: token.tokenAddress,
      addresses,
    });
    return {
      byAddress: new Map(
        balances.map((b) => [
          b.address.toLowerCase(),
          formatTokenAmount(b.rawBalance, token.tokenDecimals),
        ]),
      ),
      error: false,
    };
  } catch (e) {
    console.warn("[safes] getBalances failed", e);
    return { byAddress: new Map(), error: true };
  }
}

export const getSafes = cache(
  async (
    fundId: string,
    token: TokenContext,
  ): Promise<{ safes: SafeListRow[]; balancesError: boolean }> => {
    const rows = await prisma.fundSafe.findMany({
      where: { fundId, archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        chainId: true,
        address: true,
        threshold: true,
        status: true,
        errorMessage: true,
        _count: {
          select: {
            owners: { where: { removedAt: null } },
            transactions: { where: { status: { in: OPEN_STATUSES } } },
          },
        },
      },
    });

    // Only Safes on the token's chain can hold the fund token.
    const sameChain = rows.filter(
      (r) => isDeployedAddress(r.address) && r.chainId === token.tokenChainId,
    );
    const { byAddress, error } = await balancesFor(
      sameChain.map((r) => r.address),
      token,
    );

    return {
      safes: rows.map((r) => ({
        id: r.id,
        name: r.name,
        chainId: r.chainId,
        address: r.address,
        threshold: r.threshold,
        status: r.status,
        errorMessage: r.errorMessage,
        ownerCount: r._count.owners,
        pendingCount: r._count.transactions,
        balance: byAddress.get(r.address.toLowerCase()) ?? null,
      })),
      balancesError: error,
    };
  },
);

export const getSafeBalance = cache(
  async (
    chainId: number,
    address: string,
    token: TokenContext,
  ): Promise<{ balance: string | null; error: boolean }> => {
    if (chainId !== token.tokenChainId || !isDeployedAddress(address)) {
      return { balance: null, error: false };
    }
    const { byAddress, error } = await balancesFor([address], token);
    return { balance: byAddress.get(address.toLowerCase()) ?? null, error };
  },
);

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type SafeOwnerView = {
  address: string;
  kind: FundSafeOwnerKind;
  label: string | null; // EXTERNAL owners' operator-given label
  displayName: string; // member name/email, external label, or short address
  userId: string | null;
  email: string | null;
  image: string | null;
  isFormerMember: boolean; // MEMBER whose user left the fund staff
  addedAt: string;
};

export type SafeSignatureView = {
  ownerAddress: string;
  source: FundSafeSignatureSource;
  signedAt: string;
  userName: string | null; // who clicked Sign (LACAISSE)
};

export type SafeTxView = {
  id: string;
  nonce: number;
  kind: FundSafeTxKind;
  status: FundSafeTxStatus;
  summary: SafeTxSummary | null;
  note: string | null;
  safeTxHash: string;
  txHash: string | null;
  executedAt: string | null;
  executedBy: string | null; // "relayer" | "external"
  errorMessage: string | null;
  createdAt: string;
  proposedBy: { id: string; name: string } | null;
  signatures: SafeSignatureView[];
};

export type SafeDetail = {
  id: string;
  name: string;
  chainId: number;
  address: string;
  threshold: number;
  status: FundSafeStatus;
  deployTxHash: string | null;
  errorMessage: string | null;
  lastSyncedAt: string | null;
  owners: SafeOwnerView[]; // current (not removed)
  formerOwners: SafeOwnerView[]; // removed on chain, kept for labels
  transactions: SafeTxView[]; // nonce desc, then createdAt desc
  pending: SafeTxView[]; // open, lowest nonce first (execution order)
  history: SafeTxView[]; // settled, newest first
};

function userDisplayName(u: { name: string | null; email: string }): string {
  return u.name?.trim() || u.email;
}

export const getSafe = cache(
  async (fundId: string, safeId: string): Promise<SafeDetail | null> => {
    const safe = await prisma.fundSafe.findFirst({
      where: { id: safeId, fundId, archivedAt: null },
      include: {
        owners: {
          orderBy: { addedAt: "asc" },
          include: {
            signer: {
              select: {
                userId: true,
                user: { select: { name: true, email: true, image: true } },
              },
            },
          },
        },
        transactions: {
          orderBy: [{ nonce: "desc" }, { createdAt: "desc" }],
          include: {
            proposedBy: { select: { id: true, name: true, email: true } },
            signatures: {
              orderBy: { signedAt: "asc" },
              include: { user: { select: { name: true, email: true } } },
            },
          },
        },
      },
    });
    if (!safe) return null;

    // Which MEMBER owners still belong to the fund staff.
    const memberUserIds = safe.owners
      .map((o) => o.signer?.userId)
      .filter((id): id is string => Boolean(id));
    const stillMembers = new Set(
      memberUserIds.length === 0
        ? []
        : (
            await prisma.fundMember.findMany({
              where: { fundId, userId: { in: memberUserIds } },
              select: { userId: true },
            })
          ).map((m) => m.userId),
    );

    const owners: SafeOwnerView[] = safe.owners.map((o) => {
      const user = o.signer?.user ?? null;
      const label = o.label?.trim() || null;
      return {
        address: o.address,
        kind: o.kind,
        label,
        displayName: user
          ? userDisplayName(user)
          : (label ?? shortAddress(o.address)),
        userId: o.signer?.userId ?? null,
        email: user?.email ?? null,
        image: user?.image ?? null,
        isFormerMember:
          o.kind === "MEMBER" &&
          (!o.signer || !stillMembers.has(o.signer.userId)),
        addedAt: o.addedAt.toISOString(),
      };
    });

    const transactions: SafeTxView[] = safe.transactions.map((tx) => ({
      id: tx.id,
      nonce: tx.nonce,
      kind: tx.kind,
      status: tx.status,
      summary: parseSummary(tx.summary),
      note: tx.note,
      safeTxHash: tx.safeTxHash,
      txHash: tx.txHash,
      executedAt: tx.executedAt?.toISOString() ?? null,
      executedBy: tx.executedBy,
      errorMessage: tx.errorMessage,
      createdAt: tx.createdAt.toISOString(),
      proposedBy: tx.proposedBy
        ? { id: tx.proposedBy.id, name: userDisplayName(tx.proposedBy) }
        : null,
      signatures: tx.signatures.map((s) => ({
        ownerAddress: s.ownerAddress,
        source: s.source,
        signedAt: s.signedAt.toISOString(),
        userName: s.user ? userDisplayName(s.user) : null,
      })),
    }));

    // A FAILED tx stays "open" (retryable) until something executed at its
    // nonce or later — then it's stale and belongs to history.
    const highestExecuted = transactions.reduce(
      (max, tx) => (tx.status === "EXECUTED" ? Math.max(max, tx.nonce) : max),
      -1,
    );
    const isOpen = (tx: SafeTxView) =>
      tx.status === "PENDING" ||
      tx.status === "EXECUTING" ||
      (tx.status === "FAILED" && tx.nonce > highestExecuted);

    const pending = transactions
      .filter(isOpen)
      .sort((a, b) => a.nonce - b.nonce || a.createdAt.localeCompare(b.createdAt));
    const history = transactions.filter((tx) => !isOpen(tx));

    return {
      id: safe.id,
      name: safe.name,
      chainId: safe.chainId,
      address: safe.address,
      threshold: safe.threshold,
      status: safe.status,
      deployTxHash: safe.deployTxHash,
      errorMessage: safe.errorMessage,
      lastSyncedAt: safe.lastSyncedAt?.toISOString() ?? null,
      owners: owners.filter((_, i) => safe.owners[i]!.removedAt == null),
      formerOwners: owners.filter((_, i) => safe.owners[i]!.removedAt != null),
      transactions,
      pending,
      history,
    };
  },
);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const getCurrentSignerAddress = cache(
  async (fundId: string, userId: string): Promise<string | null> => {
    const signer = await prisma.fundSigner.findUnique({
      where: { fundId_userId: { fundId, userId } },
      select: { address: true },
    });
    return signer?.address ?? null;
  },
);

export type EligibleMember = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  signerAddress: string | null; // their FundSigner, if one exists yet
};

// Fund staff who may own a Safe: OWNER + ADMIN members.
export const getEligibleMembers = cache(
  async (fundId: string): Promise<EligibleMember[]> => {
    const members = await prisma.fundMember.findMany({
      where: { fundId, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
      select: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    });
    const userIds = members.map((m) => m.user.id);
    const signers =
      userIds.length === 0
        ? []
        : await prisma.fundSigner.findMany({
            where: { fundId, userId: { in: userIds } },
            select: { userId: true, address: true },
          });
    const signerByUser = new Map(signers.map((s) => [s.userId, s.address]));
    return members.map(({ user }) => ({
      userId: user.id,
      name: userDisplayName(user),
      email: user.email,
      image: user.image,
      signerAddress: signerByUser.get(user.id) ?? null,
    }));
  },
);

// ---------------------------------------------------------------------------
// Transfer recipients
// ---------------------------------------------------------------------------

export type RecipientOption = {
  address: string;
  label: string;
  kind: "ACCOUNT" | "CARD";
};

// The fund's named accounts (as the accounts transfer dialog offers) plus the
// cards of the fund's own staff — a small, bounded set. Any other address can
// still be pasted by hand.
export const getRecipientOptions = cache(
  async (fundId: string): Promise<RecipientOption[]> => {
    const [t, tAccounts] = await Promise.all([
      getTranslations("fund.safes"),
      getTranslations("fund.accounts"),
    ]);

    const accounts = await getAccountOptions(fundId, "");
    const options: RecipientOption[] = accounts.map((a) => ({
      address: a.address,
      label: a.name || tAccounts("defaultName"),
      kind: "ACCOUNT",
    }));

    const staff = await prisma.fundMember.findMany({
      where: { fundId },
      select: { userId: true },
    });
    const staffIds = staff.map((s) => s.userId);
    if (staffIds.length > 0) {
      const cards = await prisma.card.findMany({
        where: {
          fundId,
          account: { not: null },
          status: { not: "BLOCKED" },
          member: { fundId, userId: { in: staffIds } },
        },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: {
          account: true,
          holderName: true,
          serialNumber: true,
          member: { select: { firstName: true, lastName: true } },
        },
      });
      const seen = new Set(options.map((o) => o.address.toLowerCase()));
      for (const c of cards) {
        if (!c.account || seen.has(c.account.toLowerCase())) continue;
        seen.add(c.account.toLowerCase());
        const name =
          c.holderName?.trim() ||
          [c.member?.firstName, c.member?.lastName].filter(Boolean).join(" ").trim() ||
          c.serialNumber;
        options.push({
          address: c.account,
          label: t("transfer.cardLabel", { name }),
          kind: "CARD",
        });
      }
    }
    return options;
  },
);

// ---------------------------------------------------------------------------
// Relayer
// ---------------------------------------------------------------------------

export type RelayerStatus = {
  configured: boolean;
  address: string | null;
  balanceWei: string | null;
};

export const getRelayerStatus = cache(
  async (chainId: number): Promise<RelayerStatus> => {
    let configured = false;
    try {
      configured = isRelayerConfigured();
    } catch (e) {
      console.warn("[safes] relayer config check failed", e);
      return { configured: false, address: null, balanceWei: null };
    }
    if (!configured) return { configured, address: null, balanceWei: null };

    let address: string | null = null;
    try {
      address = relayerAddress();
    } catch (e) {
      console.warn("[safes] relayer address failed", e);
    }
    let balanceWei: string | null = null;
    try {
      balanceWei = (await relayerBalance(chainId)).toString();
    } catch (e) {
      console.warn("[safes] relayer balance failed", e);
    }
    return { configured, address, balanceWei };
  },
);
