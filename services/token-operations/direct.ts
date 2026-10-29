// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { revalidatePath } from "next/cache";
import { parseUnits } from "viem";

import { prisma } from "@/services/db/prisma";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";
import {
  attemptedUserOpHash,
  burnFromToken,
  failedBeforeSubmit,
  mintToken,
  UserOpError,
  type FundMinterContext,
} from "@/services/token/userop";

import { ManualBurnDirectSchema, ManualMintDirectSchema } from "./schemas";

// Direct mint/burn against a raw address, with the fund passed IN rather than
// derived from the request host. This is the shared core:
//   - `admin-actions.ts` wraps it with requireFundRole (dashboard / host-scoped);
//   - `services/mcp/*` wraps it with requireFundAccessForUser (fund is a tool
//     parameter, see services/mcp/authz.ts).
// Keeping one implementation matters more here than anywhere else in the app —
// this is the only code path that moves real tokens.
//
// Errors come back as translated strings: the caller injects a root
// next-intl translator so the dashboard answers in the operator's locale and
// MCP answers in English, without this module knowing about either.

/**
 * Root next-intl translator (`getTranslations()` with no namespace). `values`
 * fills ICU placeholders; translators that ignore it still fit the type.
 */
export type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

// The fund columns the minter needs: the 4337 stack identity FundMinterContext
// already describes, plus the decimals used to scale the amount. A raw Prisma
// `Fund` row satisfies this — the "is this fund provisioned?" check lives in
// userop.ts's loadFundContext, which throws loudly on a missing minter.
export type DirectTokenFund = FundMinterContext & {
  tokenDecimals: number | null;
};

export type DirectOpContext = {
  fund: DirectTokenFund;
  /** Acting user — recorded as the annotation's triggeredBy. */
  userId: string;
  t: Translate;
};

export type DirectMintResult =
  | { ok: true; txHash: string; userOpHash: string }
  | { error: string; field?: "to" | "amount" | "note" };

// A failed burn says which side of the bundler hand-off it failed on, for
// callers that must not burn twice (the payout burn claim, which may only be
// released when nothing can be on its way on chain):
//   - `broadcast: false` — certain to have failed before the userop was sent
//     (validation, missing config, decrypt, sponsoring, signing);
//   - `broadcast: true`  — it may have been sent: the submit call or the
//     confirmation poll failed, or the burn CONFIRMED and our own bookkeeping
//     after it failed (then `txHash` is set). Unknown errors land here too.
//     `userOpHash` is set whenever the userop was handed to the bundler (or
//     confirmed) — the handle to check the attempt on chain.
// A thrown error (e.g. the TokenOperation insert) is not classified — treat it
// like `broadcast: true`.
export type DirectBurnResult =
  | { ok: true; txHash: string; userOpHash: string }
  | {
      error: string;
      field?: "from" | "amount" | "note";
      broadcast: boolean;
      txHash?: string;
      userOpHash?: string;
    };

// Audit context for the annotation written on success. `trigger` is one of
// ANNOTATION_TRIGGERS. Internal callers (order settlement, payouts, account
// moves) pass their own; a raw operator mint/burn has none and MUST carry a
// note instead — that note is the audit record of *why*.
export type DirectAudit = { trigger: string };

// The operator-facing text for a failed userop. A missing MINTER_ROLE gets
// its own message naming the minter Safe and the token, because it is the one
// failure an operator can act on (ask Citizen Pay to grant the role); every
// other failure points at the operation log, where the full error is.
function failureMessage(
  t: Translate,
  fund: DirectTokenFund,
  e: unknown,
): string {
  if (e instanceof UserOpError && e.code === "missing_role") {
    return t("tokenOps.errors.minterRoleMissing", {
      safe: fund.tokenMinterSmartAccountAddress ?? "—",
      token: fund.tokenAddress ?? "—",
    });
  }
  return t("tokenOps.errors.submitFailed");
}

// The settlement tx hash of a userop that landed and reverted (receipt status
// 0x0) — kept on the FAILED row so the revert can be looked up on chain.
function revertedTxHash(e: unknown): string | undefined {
  return e instanceof UserOpError ? e.txHash : undefined;
}

export async function mintDirect(
  ctx: DirectOpContext,
  input: { to: string; amount: string; note?: string },
  audit?: DirectAudit,
): Promise<DirectMintResult> {
  const { fund, t } = ctx;

  const parsed = ManualMintDirectSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message),
      field: issue.path[0] as "to" | "amount" | undefined,
    };
  }

  const note = input.note?.trim();
  if (!audit && !note) {
    return { error: t("tokenOps.errors.noteRequired"), field: "note" };
  }

  if (!fund.tokenAddress || fund.tokenDecimals == null) {
    return { error: t("tokenOps.errors.tokenNotConfigured") };
  }

  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(parsed.data.amount, fund.tokenDecimals);
  } catch {
    return { error: t("tokenOps.errors.amountInvalid"), field: "amount" };
  }

  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "MINT",
      account: parsed.data.to,
      amount: parsed.data.amount,
      status: "PENDING",
    },
  });

  try {
    const { txHash, userOpHash } = await mintToken({
      fund,
      to: parsed.data.to as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    // The receipt succeeded, so the minter Safe demonstrably holds
    // MINTER_ROLE: record the verification so later mints skip the pre-submit
    // role read. Bookkeeping only — never turns a confirmed mint into an error.
    if (fund.tokenMintEnabledAt == null) {
      await prisma.fund
        .update({
          where: { id: fund.id },
          data: { tokenMintEnabledAt: new Date() },
        })
        .catch((err: unknown) => {
          console.warn("[mintDirect] tokenMintEnabledAt not recorded", fund.id, err);
        });
    }
    const trigger = audit?.trigger ?? ANNOTATION_TRIGGERS.adminDirectMint;
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: trigger,
      note: note ?? null,
      trigger,
      triggeredByUserId: ctx.userId,
    });
    revalidatePath("/token");
    return { ok: true, txHash, userOpHash };
  } catch (e) {
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    const txHash = revertedTxHash(e);
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "FAILED", errorMessage, ...(txHash ? { txHash } : {}) },
    });
    console.error("[mintDirect] failed", op.id, e);
    return { error: failureMessage(t, fund, e) };
  }
}

export async function burnDirect(
  ctx: DirectOpContext,
  input: { from: string; amount: string; note?: string },
  audit?: DirectAudit,
): Promise<DirectBurnResult> {
  const { fund, t } = ctx;

  const parsed = ManualBurnDirectSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message),
      field: issue.path[0] as "from" | "amount" | undefined,
      broadcast: false,
    };
  }

  const note = input.note?.trim();
  if (!audit && !note) {
    return {
      error: t("tokenOps.errors.noteRequired"),
      field: "note",
      broadcast: false,
    };
  }

  if (!fund.tokenAddress || fund.tokenDecimals == null) {
    return { error: t("tokenOps.errors.tokenNotConfigured"), broadcast: false };
  }

  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(parsed.data.amount, fund.tokenDecimals);
  } catch {
    return {
      error: t("tokenOps.errors.amountInvalid"),
      field: "amount",
      broadcast: false,
    };
  }

  // Never burn from one of this fund's Safes: the issuer's `burnFrom` needs no
  // allowance, so a single ADMIN could empty a Safe from /token and re-mint
  // elsewhere, bypassing the Safe's signature threshold. Archived and
  // not-yet-ACTIVE Safes count too — the tokens are still there.
  const safe = await prisma.fundSafe.findFirst({
    where: {
      fundId: fund.id,
      address: { equals: parsed.data.from, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (safe) {
    return {
      error: t("tokenOps.errors.fromIsSafe"),
      field: "from",
      broadcast: false,
    };
  }

  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "BURN",
      account: parsed.data.from,
      amount: parsed.data.amount,
      status: "PENDING",
    },
  });

  // Set once the burn confirmed on chain: a failure after that point is our
  // own bookkeeping, and the burn must not be reported as "not sent".
  let burned: { txHash: string; userOpHash: string } | null = null;
  try {
    const { txHash, userOpHash } = await burnFromToken({
      fund,
      from: parsed.data.from as `0x${string}`,
      amount: amountUnits,
    });
    burned = { txHash, userOpHash };
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    const trigger = audit?.trigger ?? ANNOTATION_TRIGGERS.adminDirectBurn;
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: trigger,
      note: note ?? null,
      trigger,
      triggeredByUserId: ctx.userId,
    });
    revalidatePath("/token");
    return { ok: true, txHash, userOpHash };
  } catch (e) {
    const userOpHash = burned?.userOpHash ?? attemptedUserOpHash(e);
    // TokenOperation has no userop column (and this change adds no
    // migration), so the attempted userop hash rides in the failure text —
    // the one place an operator reading the row will look.
    const errorMessage =
      (e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e)) +
      (userOpHash ? ` [userOp ${userOpHash}]` : "");
    // A burn that landed and reverted has a tx hash too (receipt 0x0).
    const txHash = burned?.txHash ?? revertedTxHash(e);
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "FAILED", errorMessage, ...(txHash ? { txHash } : {}) },
    });
    console.error("[burnDirect] failed", op.id, e);
    return {
      error: t("tokenOps.errors.submitFailed"),
      broadcast: burned !== null || !failedBeforeSubmit(e),
      ...(txHash ? { txHash } : {}),
      ...(userOpHash ? { userOpHash } : {}),
    };
  }
}
