// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { after } from "next/server";

import { decryptSecret } from "@/services/crypto/secret";
import { prisma } from "@/services/db/prisma";
import { checkMinterRole, type RoleStatus } from "@/services/token/permissions";

import {
  CitizenPayApiError,
  treasury as treasuryApi,
  type TokenRoleWire,
} from "./api";

// Minter-role provisioning for a fund's minter Safe.
//
// La Caisse mints card top-ups and burns payouts from its OWN Safe
// (`Fund.tokenMinterSmartAccountAddress`, derived from the treasury's account
// factory — see services/token/smart-account.ts), so the treasury's token has
// to grant that Safe MINTER_ROLE, and BURNER_ROLE when the token defines one.
// CP can do that from its admin Safe for every token it deployed
// (`POST /v2/treasury/token/roles`, idempotent). A token deployed by hand is
// a 409: its admin has to grant the role on chain, nothing we can do here.
//
// Callers: `consumeConnect` (best-effort, after the key pickup, via
// `scheduleEnsureMinterRoles`) and the settings Token tab's "Grant minter
// role" button (`grantMinterRoleAction`).

// CP's virtual chain (engine docs/virtual-chain.md; CP's `VCHAIN_ID`, chains
// row prefix "cp"). Its tokens' roles are the engine's, fixed at issuance —
// CP answers 422, so don't ask.
export const CITIZEN_PAY_VIRTUAL_CHAIN_ID = 321000;

const GRANT_ROLES: TokenRoleWire[] = ["minter", "burner"];

export type EnsureMinterRolesResult = {
  status: "granted" | "already" | "unsupported" | "failed";
  detail?: string;
};

/**
 * Ask Citizen Pay to grant the fund's minter Safe MINTER_ROLE + BURNER_ROLE
 * on the treasury's token. On success (CP reads `minter` back true) stamps
 * `Fund.tokenMintEnabledAt`.
 *
 *   granted     — CP sent a grant (at least one role was missing)
 *   already     — the Safe already held the roles; nothing sent
 *   unsupported — nothing to grant here: no Safe / token / creds yet, the
 *                 virtual chain, or CP refused for good (404 route missing,
 *                 409 CP isn't the token's admin, 422 virtual chain / no
 *                 issuing business). `detail` carries the reason.
 *   failed      — anything else (429 daily cap, 502 chain failure, network,
 *                 timeout — the grant may still land, re-check later)
 *
 * Never throws.
 */
export async function ensureMinterRoles(args: {
  fundId: string;
}): Promise<EnsureMinterRolesResult> {
  try {
    const baseUrl = process.env.CITIZENPAY_API_BASE_URL;
    if (!baseUrl) {
      return { status: "unsupported", detail: "CITIZENPAY_API_BASE_URL is not configured" };
    }

    const fund = await prisma.fund.findUnique({
      where: { id: args.fundId },
      select: {
        id: true,
        citizenPayApiKeyId: true,
        citizenPayApiKeyEnc: true,
        tokenMinterSmartAccountAddress: true,
        tokenAddress: true,
        tokenChainId: true,
      },
    });
    if (!fund) return { status: "unsupported", detail: "fund not found" };
    if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
      return { status: "unsupported", detail: "fund is not connected to Citizen Pay" };
    }
    if (!fund.tokenMinterSmartAccountAddress) {
      return { status: "unsupported", detail: "minter smart account not derived yet" };
    }
    if (!fund.tokenAddress) {
      return { status: "unsupported", detail: "token address not synced yet" };
    }
    if (fund.tokenChainId === CITIZEN_PAY_VIRTUAL_CHAIN_ID) {
      return { status: "unsupported", detail: "virtual-chain token" };
    }

    const creds = {
      baseUrl,
      apiKeyId: fund.citizenPayApiKeyId,
      apiKey: decryptSecret(fund.citizenPayApiKeyEnc),
    };
    const res = await treasuryApi.grantTokenRoles(creds, {
      account: fund.tokenMinterSmartAccountAddress,
      roles: GRANT_ROLES,
    });

    if (res?.minter !== true) {
      console.warn(
        "[citizenpay-roles] grant answered 200 but minter role did not read back",
        fund.id,
        fund.tokenMinterSmartAccountAddress,
      );
      return { status: "failed", detail: "minter role did not read back after the grant" };
    }

    // The grant has landed; a failed stamp must not report it as failed.
    try {
      await prisma.fund.update({
        where: { id: fund.id },
        data: { tokenMintEnabledAt: new Date() },
      });
    } catch (e) {
      console.warn("[citizenpay-roles] could not stamp tokenMintEnabledAt", fund.id, e);
    }

    const granted = Array.isArray(res.granted) ? res.granted : [];
    if (granted.length > 0) {
      console.log(
        "[citizenpay-roles] granted",
        granted.join(","),
        "to",
        fund.tokenMinterSmartAccountAddress,
        "fund",
        fund.id,
        "userOps",
        (res.user_op_hashes ?? []).join(","),
      );
      return { status: "granted" };
    }
    return { status: "already" };
  } catch (e) {
    if (e instanceof CitizenPayApiError) {
      if (e.status === 404 || e.status === 409 || e.status === 422) {
        console.warn(
          `[citizenpay-roles] grant unsupported (${e.status})`,
          args.fundId,
          e.message,
        );
        return { status: "unsupported", detail: e.message };
      }
      console.warn(`[citizenpay-roles] grant failed (${e.status})`, args.fundId, e.message);
      return { status: "failed", detail: e.message };
    }
    const detail =
      e instanceof Error && e.name === "AbortError"
        ? "timed out waiting for Citizen Pay — the grant may still land"
        : e instanceof Error
          ? e.message
          : "unknown error";
    console.warn("[citizenpay-roles] grant failed", args.fundId, detail);
    return { status: "failed", detail };
  }
}

/**
 * Run `ensureMinterRoles` after the current response is sent (Next's
 * `after`): the grant waits for a UserOp receipt, which must not hold the
 * connect callback's redirect. Never throws.
 */
export function scheduleEnsureMinterRoles(fundId: string): void {
  try {
    after(async () => {
      await ensureMinterRoles({ fundId });
    });
  } catch (e) {
    // `after` throws outside a request scope — nothing to defer to then.
    console.warn("[citizenpay-roles] could not schedule the minter-role grant", fundId, e);
  }
}

/**
 * The settings Token tab's on-chain MINTER_ROLE check, plus the bookkeeping
 * that goes with it: a Safe that holds the role on a fund whose
 * `tokenMintEnabledAt` is still null (role granted out of band, or before
 * this column was written) gets it stamped now. The stamp is best-effort —
 * a failed write still returns the status.
 */
export async function checkAndRecordMinterRole(args: {
  fundId: string;
  tokenAddress: string;
  chainId: number;
  account: string;
  mintEnabledAt: Date | null;
}): Promise<RoleStatus> {
  const status = await checkMinterRole({
    tokenAddress: args.tokenAddress,
    chainId: args.chainId,
    account: args.account,
  });
  if (status === "has-role" && args.mintEnabledAt == null) {
    try {
      await prisma.fund.updateMany({
        where: { id: args.fundId, tokenMintEnabledAt: null },
        data: { tokenMintEnabledAt: new Date() },
      });
    } catch (e) {
      console.warn("[citizenpay-roles] could not stamp tokenMintEnabledAt", args.fundId, e);
    }
  }
  return status;
}
