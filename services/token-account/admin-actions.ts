// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { refresh, revalidatePath } from "next/cache";
import { parseUnits } from "viem";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import { deriveSmartAccountAddress } from "@/services/token/smart-account";
import {
  transferFromAccount,
  UserOpError,
  type FundMinterContext,
} from "@/services/token/userop";
import {
  manualBurnDirectAction,
  manualMintDirectAction,
} from "@/services/token-operations/admin-actions";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";

import {
  CreateTokenAccountSchema,
  MoveTokensSchema,
  RenameTokenAccountSchema,
  TransferTokensSchema,
} from "./schemas";
import { fundAccountSerial } from "./serial";
import {
  loadAccountTransfers,
  type AccountTransfersPage,
} from "./transfers";

export type TokenAccountResult = { error: string } | { ok: true };
export type MoveTokensResult =
  | { error: string }
  | { ok: true; txHash: string };
export type AccountTransfersResult =
  | { error: string }
  | ({ ok: true } & AccountTransfersPage);

// Create a named account. STANDARD accounts are counterfactual Safes derived
// from the minter EOA. A SOURCE account is, on CitizenPay, just a card: we mint
// a serial (CP's serial accepts any string) and register it via the normal card
// path, so CP assigns the wallet and the account can back cards as their source.
export async function createTokenAccountAction(input: {
  name: string;
  kind?: "STANDARD" | "SOURCE";
}): Promise<TokenAccountResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = CreateTokenAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }

  if (!fund.tokenMinterEoaAddress || !fund.citizenPayAccountFactoryAddress) {
    return { error: t("fund.accounts.errors.notConnected" as never) };
  }

  // Next salt = highest existing + 1 (≥ 1). The unique (fundId, saltNonce)
  // index is the backstop if two creates race. For SOURCE accounts this is just
  // a per-fund sequence number that also seeds the serial (no Safe derivation).
  const last = await prisma.fundTokenAccount.findFirst({
    where: { fundId: fund.id },
    orderBy: { saltNonce: "desc" },
    select: { saltNonce: true },
  });
  const saltNonce = (last?.saltNonce ?? 0) + 1;

  let address: string;
  let serial: string | null = null;

  if (parsed.data.kind === "SOURCE") {
    // Register the card on CP with our generated serial; CP assigns the wallet
    // and returns its address, which is what the account holds and what CP
    // pulls from when this account backs a card.
    serial = fundAccountSerial(fund.id, saltNonce);
    let registered;
    try {
      registered = await getCitizenPayClient(fund).registerCard({
        serialNumber: serial,
        fundId: fund.id,
        fundCitizenPayId: fund.citizenPayFundId,
        holderName: parsed.data.name,
      });
    } catch (e) {
      console.error("[token-account] CP card registration failed", e);
      return { error: t("fund.accounts.errors.registerFailed" as never) };
    }
    if (!registered.account) {
      // No address back means we'd persist a card we can't fund/pull from.
      return { error: t("fund.accounts.errors.registerFailed" as never) };
    }
    address = registered.account;
  } else {
    const derived = await deriveSmartAccountAddress({
      eoaAddress: fund.tokenMinterEoaAddress,
      factoryAddress: fund.citizenPayAccountFactoryAddress,
      saltNonce: BigInt(saltNonce),
    });
    if (!derived) {
      return { error: t("fund.accounts.errors.deriveFailed" as never) };
    }
    address = derived;
  }

  try {
    await prisma.fundTokenAccount.create({
      data: {
        fundId: fund.id,
        name: parsed.data.name,
        saltNonce,
        address,
        kind: parsed.data.kind,
        serial,
      },
    });
  } catch (e) {
    console.error("[token-account] create failed", e);
    return { error: t("fund.accounts.errors.createFailed" as never) };
  }

  revalidatePath("/accounts");
  refresh();
  return { ok: true };
}

export async function renameTokenAccountAction(input: {
  id: string;
  name: string;
}): Promise<TokenAccountResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = RenameTokenAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }

  // Scope the write to this fund so an admin can't touch another fund's row.
  const res = await prisma.fundTokenAccount.updateMany({
    where: { id: parsed.data.id, fundId: fund.id, archivedAt: null },
    data: { name: parsed.data.name },
  });
  if (res.count === 0) {
    return { error: t("fund.accounts.errors.notFound" as never) };
  }

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.id}`);
  refresh();
  return { ok: true };
}

export async function archiveTokenAccountAction(input: {
  id: string;
}): Promise<TokenAccountResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const account = await prisma.fundTokenAccount.findFirst({
    where: { id: input.id, fundId: fund.id, archivedAt: null },
    select: { saltNonce: true },
  });
  if (!account) return { error: t("fund.accounts.errors.notFound" as never) };
  // Salt 0 is the minter's own Safe — the fund's default account, not removable.
  if (account.saltNonce === 0) {
    return { error: t("fund.accounts.errors.cannotRemoveDefault" as never) };
  }

  await prisma.fundTokenAccount.update({
    where: { id: input.id },
    data: { archivedAt: new Date() },
  });

  // No refresh() here: the client navigates to /accounts after archiving, and
  // refreshing the now-archived detail route would 404. The list is revalidated.
  revalidatePath("/accounts");
  return { ok: true };
}

// Move tokens IN: mint the amount to the account. Reuses the minter mint path
// (records a TokenOperation, submits the paymaster-sponsored UserOp).
export async function accountMintInAction(input: {
  id: string;
  amount: string;
}): Promise<MoveTokensResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = MoveTokensSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }

  const account = await prisma.fundTokenAccount.findFirst({
    where: { id: parsed.data.id, fundId: fund.id, archivedAt: null },
    select: { address: true },
  });
  if (!account) return { error: t("fund.accounts.errors.notFound" as never) };

  const mint = await manualMintDirectAction(
    {
      to: account.address,
      amount: parsed.data.amount,
    },
    { trigger: ANNOTATION_TRIGGERS.accountMint },
  );
  if ("error" in mint) return { error: mint.error };

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.id}`);
  refresh();
  return { ok: true, txHash: mint.txHash };
}

// Move tokens OUT: burn the amount from the account (reuses the minter burn
// path — the minter Safe holds the burn role).
export async function accountBurnOutAction(input: {
  id: string;
  amount: string;
}): Promise<MoveTokensResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = MoveTokensSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }

  const account = await prisma.fundTokenAccount.findFirst({
    where: { id: parsed.data.id, fundId: fund.id, archivedAt: null },
    select: { address: true },
  });
  if (!account) return { error: t("fund.accounts.errors.notFound" as never) };

  const burn = await manualBurnDirectAction(
    {
      from: account.address,
      amount: parsed.data.amount,
    },
    { trigger: ANNOTATION_TRIGGERS.accountBurn },
  );
  if ("error" in burn) return { error: burn.error };

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.id}`);
  refresh();
  return { ok: true, txHash: burn.txHash };
}

// Transfer tokens FROM this account to another address (another fund account
// or any wallet). A real ERC20 transfer signed by the minter EOA on behalf of
// the account's Safe — recorded as a TRANSFER TokenOperation.
export async function accountTransferAction(input: {
  id: string;
  to: string;
  amount: string;
}): Promise<MoveTokensResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = TransferTokensSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }

  if (!fund.tokenAddress || fund.tokenDecimals == null) {
    return { error: t("fund.accounts.errors.notConnected" as never) };
  }

  const account = await prisma.fundTokenAccount.findFirst({
    where: { id: parsed.data.id, fundId: fund.id, archivedAt: null },
    select: { address: true, saltNonce: true, kind: true },
  });
  if (!account) return { error: t("fund.accounts.errors.notFound" as never) };
  // SOURCE accounts fund cards; they're not a transfer origin. The picker is
  // hidden for them, but re-check here so the action can't be called directly.
  if (account.kind === "SOURCE") {
    return { error: t("fund.accounts.errors.cannotTransferSource" as never) };
  }

  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(parsed.data.amount, fund.tokenDecimals);
  } catch {
    return { error: t("fund.accounts.errors.amountInvalid" as never) };
  }

  // Record the op up front (PENDING → CONFIRMED/FAILED). `account` is the
  // recipient, per the column's "address that received the tokens" meaning.
  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "TRANSFER",
      account: parsed.data.to,
      amount: parsed.data.amount,
      status: "PENDING",
    },
  });

  try {
    const { txHash, userOpHash } = await transferFromAccount({
      fund: fund as FundMinterContext,
      saltNonce: BigInt(account.saltNonce),
      sender: account.address as `0x${string}`,
      to: parsed.data.to as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: ANNOTATION_TRIGGERS.accountTransfer,
      trigger: ANNOTATION_TRIGGERS.accountTransfer,
      triggeredByUserId: user.id,
    });
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${parsed.data.id}`);
    refresh();
    return { ok: true, txHash };
  } catch (e) {
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "FAILED", errorMessage },
    });
    console.error("[token-account] transfer failed", op.id, e);
    return { error: t("fund.accounts.errors.transferFailed" as never) };
  }
}

// Load-more for the detail page's transfer history.
export async function getAccountTransfersAction(input: {
  id: string;
  cursor?: string | null;
}): Promise<AccountTransfersResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const account = await prisma.fundTokenAccount.findFirst({
    where: { id: input.id, fundId: fund.id },
    select: { address: true },
  });
  if (!account) return { error: t("fund.accounts.errors.notFound" as never) };

  try {
    const page = await loadAccountTransfers(
      fund.id,
      fund,
      account.address,
      input.cursor ?? null,
    );
    return { ok: true, ...page };
  } catch (e) {
    console.error("[token-account] transfers failed", input.id, e);
    return { error: t("fund.accounts.errors.transfersFailed" as never) };
  }
}
