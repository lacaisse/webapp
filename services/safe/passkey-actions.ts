// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { refresh, revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { getCurrentSession, requireFundRole } from "@/services/auth/dal";
import { hasRecentAuth, issueRecentAuthProof } from "@/services/auth/step-up";
import { prisma } from "@/services/db/prisma";

import {
  REAUTH_REQUIRED,
  type ActionError,
  type PasskeyDeployResult,
  type PasskeyRegistrationFinishResult,
  type PasskeyRegistrationStartResult,
  type SignActionResult,
} from "./action-types";
import { signingPasskeyRpId } from "./passkey-rp";
import { encodeWebAuthnSignature } from "./passkey-signature";
import {
  beginSigningPasskeyRegistration,
  ensurePasskeySignerDeployed,
  findActivePasskeySigner,
  finishSigningPasskeyRegistration,
  verifyPasskeySignerAssertion,
} from "./passkey-signers";
import { signTransactionWithPasskey } from "./proposals";
import {
  FinishPasskeyRegistrationSchema,
  SignWithPasskeySchema,
  StartPasskeyRegistrationSchema,
} from "./schemas";
import { isSafeError } from "./types";

// Server actions of the two passkey ceremonies (ADMIN-gated like the other
// Safe actions; the fund comes from the host). Registration: start mints a
// challenge, finish verifies the browser's attestation, derives + deploys
// the signer contract and stores the FundPasskeySigner row. Signing: the
// browser's assertion over the safeTxHash is verified against the member's
// credential, turned into the signer contract's signature and stored
// through proposals.ts — and, since the member just proved possession of
// their passkey with user verification, that same assertion counts as the
// step-up re-authentication (a proof is minted for this session).

type T = Awaited<ReturnType<typeof getTranslations>>;

function errorFor(t: T, e: unknown, context: string): string {
  if (isSafeError(e)) {
    if (e.code !== "passkey_exists" && e.code !== "not_owner" && e.code !== "already_signed") {
      console.warn(`[safe] ${context}:`, e.code, e.message);
    }
    return t(`fund.safes.errors.${e.code}` as never);
  }
  console.error(`[safe] ${context} failed`, e);
  return t("fund.safes.errors.unknown" as never);
}

async function requireStepUp(t: T): Promise<ActionError | null> {
  if (await hasRecentAuth()) return null;
  return { error: t("auth.errors.reauthRequired" as never), code: REAUTH_REQUIRED };
}

const isProd = process.env.NODE_ENV === "production";

// rpID = the apex (same as the login passkey plugin, services/auth/better-
// auth.ts), so a signing passkey registered on a fund host works on every
// host of the fund; in dev the request host (passkey-rp.ts). The expected
// origin is the host this request came in on — the proxy validated it
// against Fund.domain / the apex before the action ran, and the browser's
// clientDataJSON must name exactly it.
async function rpID(): Promise<string> {
  const h = await headers();
  return signingPasskeyRpId(process.env.APP_DOMAIN ?? "localhost", h.get("host") ?? "");
}

async function expectedOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const proto = h.get("x-forwarded-proto") ?? (isProd ? "https" : "http");
  return `${proto}://${h.get("host") ?? ""}`;
}

export async function startSigningPasskeyRegistrationAction(input: {
  replace?: boolean;
}): Promise<PasskeyRegistrationStartResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");
  const parsed = StartPasskeyRegistrationSchema.safeParse(input ?? {});
  if (!parsed.success) return { error: t("fund.safes.errors.invalid_state" as never) };

  const stepUp = await requireStepUp(t);
  if (stepUp) return stepUp;

  try {
    const { challengeId, options } = await beginSigningPasskeyRegistration({
      fund: { id: fund.id, name: fund.name },
      user: { id: user.id, email: user.email },
      rpID: await rpID(),
      replace: parsed.data.replace,
    });
    return { ok: true, challengeId, options };
  } catch (e) {
    return { error: errorFor(t, e, "passkey registration start") };
  }
}

export async function finishSigningPasskeyRegistrationAction(input: {
  challengeId: string;
  response: unknown;
}): Promise<PasskeyRegistrationFinishResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");
  const parsed = FinishPasskeyRegistrationSchema.safeParse(input);
  if (!parsed.success) return { error: t("fund.safes.errors.invalid_signature" as never) };

  try {
    const res = await finishSigningPasskeyRegistration({
      fundId: fund.id,
      userId: user.id,
      chainId: fund.tokenChainId,
      challengeId: parsed.data.challengeId,
      response: parsed.data.response,
      expectedOrigin: await expectedOrigin(),
      rpID: await rpID(),
    });
    revalidatePath("/accounts");
    refresh();
    return {
      ok: true,
      address: res.row.address,
      deployed: res.deployed,
      backupEligible: res.row.backupEligible,
      backupState: res.row.backupState,
      deployError: res.deployError,
    };
  } catch (e) {
    return { error: errorFor(t, e, "passkey registration finish") };
  }
}

/** Deploy (or re-check) the current user's signer contract for this fund. */
export async function deploySigningPasskeyAction(): Promise<PasskeyDeployResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");
  try {
    const row = await findActivePasskeySigner(fund.id, user.id);
    if (!row) return { error: t("fund.safes.errors.passkey_missing" as never) };
    const deployed = await ensurePasskeySignerDeployed(row, fund.tokenChainId);
    revalidatePath("/accounts");
    refresh();
    return { ok: true, address: deployed.address };
  } catch (e) {
    return { error: errorFor(t, e, "passkey signer deploy") };
  }
}

/**
 * Sign a pending transaction with the current user's signing passkey. The
 * assertion's challenge is the safeTxHash, so one tap both authenticates
 * the member (step-up) and signs the transaction.
 */
export async function signTransactionWithPasskeyAction(input: {
  safeId: string;
  transactionId: string;
  response: unknown;
}): Promise<SignActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");
  const parsed = SignWithPasskeySchema.safeParse(input);
  if (!parsed.success) return { error: t("fund.safes.errors.invalid_signature" as never) };
  const { safeId, transactionId, response } = parsed.data;

  try {
    const row = await findActivePasskeySigner(fund.id, user.id);
    if (!row) return { error: t("fund.safes.errors.passkey_missing" as never) };
    const tx = await prisma.fundSafeTransaction.findFirst({
      where: { id: transactionId, safeId, safe: { fundId: fund.id } },
      select: { safeTxHash: true },
    });
    if (!tx) return { error: t("fund.safes.errors.not_found" as never) };

    const verified = await verifyPasskeySignerAssertion({
      row,
      safeTxHash: tx.safeTxHash as `0x${string}`,
      response,
      expectedOrigin: await expectedOrigin(),
      rpID: await rpID(),
    });

    // The ceremony is a fresh, user-verified authentication of this member on
    // this host: record it as the step-up proof for the session.
    const session = await getCurrentSession();
    if (session) {
      await issueRecentAuthProof({
        userId: user.id,
        sessionToken: session.session.token,
        method: "passkey",
      });
    }

    const res = await signTransactionWithPasskey({
      fundId: fund.id,
      transactionId,
      userId: user.id,
      dynamicPart: encodeWebAuthnSignature(verified.signature),
    });
    revalidatePath("/accounts");
    revalidatePath(`/accounts/safes/${safeId}`);
    refresh();
    return { ok: true, executed: res.executed, txHash: res.txHash };
  } catch (e) {
    revalidatePath(`/accounts/safes/${safeId}`);
    refresh();
    return { error: errorFor(t, e, "sign with passkey") };
  }
}
