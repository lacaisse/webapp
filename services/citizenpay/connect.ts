// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { randomBytes } from "node:crypto";

import { encryptSecret } from "@/services/crypto/secret";
import type { FeeCollectionFrequency } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { getFundUrl } from "@/services/fund/server";
import { deriveSmartAccountAddress } from "@/services/token/smart-account";

import {
  buildRegistrationPrefill,
  type RegistrationPrefill,
} from "./register-prefill";
import { fetchTokenInfo } from "./sync";
import { scheduleTreasuryTopUpUrlSync } from "./sync-top-up-url";

// CitizenPay treasury handoffs. Two entry points, one callback:
//
//   Flow 1 — "Register a treasury" (`initiateTreasuryRegistration`): the
//   fund has no `citizenPayFundId` yet. We send the admin to CP's
//   /v2/treasury/register with the fund's name/symbol pre-filled; CP's
//   dashboard creates the treasury (and, for Gnosis, lets the admin deploy
//   the token right there), mints the first API key, and redirects back.
//
//   Flow 2 — "Mint a new key for an existing treasury" (`initiateKeyIssue`):
//   the fund already carries a `citizenPayFundId` (either from Flow 1 or
//   pasted by hand in settings); we send the admin to
//   /v2/treasury/keys/register to mint (or rotate) the API key.
//
// Shared mechanics:
//   1. The route mints a fund-state row and redirects to CP with a
//      `redirect_uri` carrying our fund state in the path segment.
//   2. CP confirms with the user + mints the key, then redirects back to
//      /api/citizenpay/callback/<fundState>?state=<cpState>&pickup=<token>&treasury_id=<uuid>.
//   3. The callback validates the fund state against
//      CitizenPayConnectAttempt, POSTs CP's pickup endpoint exactly once
//      to receive {api_key, api_key_id, treasury_id}, encrypts the key,
//      and writes all three columns to the Fund. Both flows deliver the
//      same pickup shape, so the callback doesn't know (or care) which
//      one it is finishing.
//
// CSRF: CP generates its own opaque `state`; we cannot trust it on its
// own. So we mint a *fund state* (random, single-use, 30-min TTL) and
// encode it into the path segment of the redirect_uri we hand to CP. The
// callback validates the fund state before doing anything. Path-segment
// (not query) so CP can string-append `?state=…&pickup=…&treasury_id=…`
// without colliding with an existing `?`.
//
// Allowlist (CP side, out of band): CP only accepts redirect_uris whose
// host matches an entry in TREASURY_REGISTER_ALLOWED_DOMAINS. We need
// `*.lacaisse.eu` registered for prod fund subdomains and `localhost` for
// dev. Without it, step 1 fails before the user reaches CP.

const CP_TREASURY_REGISTER_PATH = "/v2/treasury/register";
const CP_KEYS_REGISTER_PATH = "/v2/treasury/keys/register";
const CP_PICKUP_PATH = "/v2/treasury/register/pickup";

// Match CP's spec ("State lifetime: 30 min").
const STATE_TTL_MS = 30 * 60 * 1000;

// Schema default for `Fund.feeCollectionFrequency`. The column is never null,
// so "still the default" is the closest thing to "never configured here".
const DEFAULT_FEE_FREQUENCY: FeeCollectionFrequency = "PER_PAYMENT";

export class ConnectError extends Error {
  constructor(
    public readonly code:
      | "no_base_url"
      | "state_not_found"
      | "state_expired"
      | "state_consumed"
      | "host_mismatch"
      | "pickup_failed"
      | "missing_params"
      | "not_connected"
      | "registration_pending"
      | "treasury_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/**
 * Mint a fund state, persist it, return the CP URL the browser should be
 * redirected to to mint a (new) API key for the given treasury.
 *
 * Used for both first-time issuance (when the fund has a treasury but no
 * key yet) and rotation (when both are set) — same mechanic either way.
 */
export async function initiateKeyIssue(args: {
  fundId: string;
  returnHost: string;
  treasuryId: string;
  keyName?: string;
}): Promise<{ redirectUrl: string }> {
  const baseUrl = requireBaseUrl();
  const fundState = await issueFundState(args.fundId, args.returnHost);

  const cpUrl = new URL(CP_KEYS_REGISTER_PATH, baseUrl);
  cpUrl.searchParams.set("treasury_id", args.treasuryId);
  cpUrl.searchParams.set("redirect_uri", redirectUriFor(args.returnHost, fundState));
  if (args.keyName) cpUrl.searchParams.set("key_name", args.keyName);
  return { redirectUrl: cpUrl.toString() };
}

/**
 * Mint a fund state, persist it, return the CP URL the browser should be
 * redirected to to *register a new treasury* (Flow 1). Only meaningful
 * while the fund has no `citizenPayFundId` — the route enforces that.
 *
 * Prefill keys are the ones CP's register page reads back out of the
 * stored registration (`name`, `symbol`, `decimals`, `chain`, …) — see
 * `register-prefill.ts`. CP keeps every query param except `redirect_uri`
 * as prefill, so only send what we actually want on the form.
 *
 * Refused (`registration_pending`) while an unconsumed, unexpired attempt
 * exists for the fund: each attempt is a registration CP may still finish,
 * and two of them landing would mean two treasuries for one fund.
 * `consumeConnect` is the second line of defence (`treasury_mismatch`).
 */
export async function initiateTreasuryRegistration(args: {
  fundId: string;
  returnHost: string;
  prefill: RegistrationPrefill;
}): Promise<{ redirectUrl: string }> {
  const baseUrl = requireBaseUrl();
  if (await hasPendingAttempt(args.fundId)) {
    throw new ConnectError(
      "registration_pending",
      "A registration started less than 30 minutes ago is still open",
    );
  }
  const fundState = await issueFundState(args.fundId, args.returnHost);

  const cpUrl = new URL(CP_TREASURY_REGISTER_PATH, baseUrl);
  cpUrl.searchParams.set("redirect_uri", redirectUriFor(args.returnHost, fundState));
  for (const [key, value] of Object.entries(
    buildRegistrationPrefill(args.prefill),
  )) {
    cpUrl.searchParams.set(key, value);
  }
  return { redirectUrl: cpUrl.toString() };
}

export type ConsumedConnection = {
  treasuryId: string;
  apiKeyId: string;
};

/**
 * Validate the fund state, exchange the pickup token for credentials,
 * persist them onto the Fund, mark the attempt consumed — all in one
 * transaction. Pure function over its inputs (no Next coupling).
 */
export async function consumeConnect(args: {
  fundState: string;
  cpState: string;
  pickupToken: string;
  callbackHost: string;
}): Promise<ConsumedConnection> {
  const row = await prisma.citizenPayConnectAttempt.findUnique({
    where: { state: args.fundState },
  });
  if (!row) {
    throw new ConnectError("state_not_found", "Unknown fund state");
  }
  if (row.consumedAt) {
    throw new ConnectError("state_consumed", "Fund state already consumed");
  }
  if (row.expiresAt < new Date()) {
    throw new ConnectError("state_expired", "Fund state expired");
  }
  if (row.returnHost !== args.callbackHost) {
    throw new ConnectError(
      "host_mismatch",
      `Callback host ${args.callbackHost} does not match ${row.returnHost}`,
    );
  }

  const creds = await exchangePickup({
    state: args.cpState,
    pickupToken: args.pickupToken,
  });

  const fundRow = await prisma.fund.findUnique({
    where: { id: row.fundId },
    select: {
      citizenPayFundId: true,
      tokenMinterEoaAddress: true,
      payoutFeePercentage: true,
      feeCollectionFrequency: true,
    },
  });

  // A pickup for a different treasury than the one already on the fund
  // (a second registration racing the first, or a key minted for the wrong
  // treasury) must not re-point the fund. The key CP just minted is lost —
  // acceptable, the alternative is a fund silently switching treasuries.
  if (fundRow?.citizenPayFundId && fundRow.citizenPayFundId !== creds.treasury_id) {
    throw new ConnectError(
      "treasury_mismatch",
      `Pickup is for treasury ${creds.treasury_id} but the fund is on ${fundRow.citizenPayFundId}`,
    );
  }

  // Best-effort: pull the treasury's token info so the Fund.token* cache
  // columns are populated as part of the same write. If CP is unreachable
  // we still persist credentials — a subsequent rotate or background sync
  // can fill the cache later.
  const tokenInfo = await fetchTokenInfo({
    baseUrl: process.env.CITIZENPAY_API_BASE_URL ?? "",
    apiKeyId: creds.api_key_id,
    apiKey: creds.api_key,
  });

  // Smart-account derivation depends on the factory address CP just
  // returned, and the minter EOA already on the Fund (provisioned at
  // create-time). Re-derive on every (re)connect so a treasury that
  // changes factory address rolls the SA forward in the same write.
  let smartAccountAddress: string | null = null;
  // Fee reconciliation against CP's echo — rate AND collection cadence, the
  // pair we push together in one PATCH. Both are canonical here, so we never
  // clobber a locally-set value — we only use CP's reported values to confirm
  // the sync landed or to seed a first value. `payoutFeeSynced` covers both.
  let feeWrite:
    | {
        payoutFeePercentage?: string;
        feeCollectionFrequency?: FeeCollectionFrequency;
        payoutFeeSynced: boolean;
      }
    | null = null;
  if (tokenInfo) {
    if (tokenInfo.citizenPayAccountFactoryAddress && fundRow?.tokenMinterEoaAddress) {
      smartAccountAddress = await deriveSmartAccountAddress({
        eoaAddress: fundRow.tokenMinterEoaAddress,
        factoryAddress: tokenInfo.citizenPayAccountFactoryAddress,
      });
    }

    const localFee = fundRow?.payoutFeePercentage ?? null;
    const cpFee = tokenInfo.payoutFeePercentage;
    let seededFee: string | undefined;
    let rateSynced: boolean;
    if (localFee == null) {
      // No local value yet — adopt CP's as the seed (if any). Either way
      // there's nothing pending locally, so we're in sync.
      if (cpFee != null) seededFee = cpFee;
      rateSynced = true;
    } else {
      // Local value wins. CP echoing the same number confirms our push
      // landed; anything else means CP is stale → flag for a re-push.
      rateSynced = cpFee != null && Number(cpFee) === Number(localFee);
    }

    // Same story for the cadence, except the column is never null — it has a
    // default. So "still the default" stands in for "never configured here",
    // and only then do we adopt CP's value.
    const localFrequency = fundRow?.feeCollectionFrequency ?? DEFAULT_FEE_FREQUENCY;
    const cpFrequency = tokenInfo.feeCollectionFrequency;
    let seededFrequency: FeeCollectionFrequency | undefined;
    if (localFrequency === DEFAULT_FEE_FREQUENCY && cpFrequency != null) {
      seededFrequency = cpFrequency;
    }
    // CP staying silent about the cadence can't confirm anything — and won't
    // until the assumed PATCH/GET contract ships — so it must not flip an
    // otherwise-synced fund to "pending". Only a cadence CP reports and that
    // disagrees with ours means CP is stale.
    const effectiveFrequency = seededFrequency ?? localFrequency;
    const frequencySynced = cpFrequency == null || cpFrequency === effectiveFrequency;

    feeWrite = {
      ...(seededFee != null && { payoutFeePercentage: seededFee }),
      ...(seededFrequency != null && { feeCollectionFrequency: seededFrequency }),
      payoutFeeSynced: rateSynced && frequencySynced,
    };
  }

  const now = new Date();
  const [connectedFund] = await prisma.$transaction([
    prisma.fund.update({
      where: { id: row.fundId },
      data: {
        citizenPayFundId: creds.treasury_id,
        citizenPayApiKeyId: creds.api_key_id,
        citizenPayApiKeyEnc: encryptSecret(creds.api_key),
        citizenPayApiKeyUpdatedAt: now,
        // Token cache — only overwrite each field if CP gave us a value
        // (avoid wiping a previously-good cache because of a partial
        // response).
        ...(tokenInfo?.tokenAddress != null && {
          tokenAddress: tokenInfo.tokenAddress,
        }),
        ...(tokenInfo?.tokenChainId != null && {
          tokenChainId: tokenInfo.tokenChainId,
        }),
        ...(tokenInfo?.tokenDecimals != null && {
          tokenDecimals: tokenInfo.tokenDecimals,
        }),
        ...(tokenInfo?.tokenName != null && {
          tokenName: tokenInfo.tokenName,
        }),
        ...(tokenInfo?.tokenSymbol != null && {
          tokenSymbol: tokenInfo.tokenSymbol,
        }),
        ...(tokenInfo?.tokenLogoUrl != null && {
          tokenLogoUrl: tokenInfo.tokenLogoUrl,
        }),
        // 4337 stack cache — same conditional-overwrite rule. Required
        // by services/token/userop.ts at mint/burn time.
        ...(tokenInfo?.citizenPayEntrypointAddress != null && {
          citizenPayEntrypointAddress: tokenInfo.citizenPayEntrypointAddress,
        }),
        ...(tokenInfo?.citizenPayAccountFactoryAddress != null && {
          citizenPayAccountFactoryAddress:
            tokenInfo.citizenPayAccountFactoryAddress,
        }),
        ...(tokenInfo?.citizenPayPaymasterAddress != null && {
          citizenPayPaymasterAddress: tokenInfo.citizenPayPaymasterAddress,
        }),
        ...(tokenInfo?.citizenPayPaymasterType != null && {
          citizenPayPaymasterType: tokenInfo.citizenPayPaymasterType,
        }),
        ...(tokenInfo?.citizenPayTreasurySlug != null && {
          citizenPayTreasurySlug: tokenInfo.citizenPayTreasurySlug,
        }),
        ...(smartAccountAddress != null && {
          tokenMinterSmartAccountAddress: smartAccountAddress,
        }),
        // Fee reconciliation (seed and/or sync flag) — never overwrites a
        // locally-set fee value; see feeWrite above.
        ...(feeWrite ?? {}),
      },
    }),
    prisma.citizenPayConnectAttempt.update({
      where: { state: args.fundState },
      data: { consumedAt: now },
    }),
  ]);

  // Materialise the minter's own Safe (salt 0) as the fund's default, non-
  // deletable token account so it shows up alongside named accounts with a
  // balance + history. Best-effort and idempotent — keyed on (fundId, salt 0),
  // address refreshed if the factory (and thus the derived address) changed.
  // Empty name → the UI renders a localised "main account" label.
  if (smartAccountAddress) {
    try {
      await prisma.fundTokenAccount.upsert({
        where: { fundId_saltNonce: { fundId: row.fundId, saltNonce: 0 } },
        create: {
          fundId: row.fundId,
          name: "",
          saltNonce: 0,
          address: smartAccountAddress,
        },
        update: { address: smartAccountAddress },
      });
    } catch (e) {
      console.warn("[citizenpay] default token account upsert failed", e);
    }
  }

  // Publish the fund's contribution link as the treasury's top-up URL so a
  // freshly connected (or re-keyed) PAY_AND_GO fund gets the wallet's "Add
  // funds" button right away. Uses the row the transaction returned (no
  // extra read that could fail a connect that already committed) and runs
  // after the redirect is sent; never throws. Both flows (register a
  // treasury, mint a key) finish here, so both publish the link.
  if (connectedFund) scheduleTreasuryTopUpUrlSync(connectedFund);

  return { treasuryId: creds.treasury_id, apiKeyId: creds.api_key_id };
}

/**
 * Build the CP-facing redirect_uri. Fund state goes in the path so CP's
 * `?state=…&pickup=…&treasury_id=…` append doesn't collide with an
 * existing `?` on a query-encoded approach.
 *
 * `returnHost` is the canonical `Fund.domain` (what proxy.ts forwards via
 * `x-fund-domain`). `getFundUrl` translates that back to the routable host
 * for the current env — `acme.lacaisse.eu` stays put in prod, becomes
 * `acme.localhost:3000` in dev — so the URL we hand CP is one the user's
 * browser can actually reach.
 */
export function redirectUriFor(returnHost: string, fundState: string): string {
  return `${getFundUrl(returnHost)}/api/citizenpay/callback/${encodeURIComponent(fundState)}`;
}

// =============================================================================
// Internal
// =============================================================================

/** An unconsumed, unexpired attempt — a handoff CP may still complete. */
async function hasPendingAttempt(fundId: string): Promise<boolean> {
  const pending = await prisma.citizenPayConnectAttempt.findFirst({
    where: { fundId, consumedAt: null, expiresAt: { gt: new Date() } },
    select: { state: true },
  });
  return pending !== null;
}

async function issueFundState(fundId: string, returnHost: string): Promise<string> {
  const fundState = randomBytes(32).toString("base64url");
  await prisma.citizenPayConnectAttempt.create({
    data: {
      state: fundState,
      fundId,
      returnHost,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  return fundState;
}

type PickupResponse = {
  treasury_id: string;
  api_key_id: string;
  api_key: string;
};

async function exchangePickup(args: {
  state: string;
  pickupToken: string;
}): Promise<PickupResponse> {
  const baseUrl = requireBaseUrl();
  const url = new URL(CP_PICKUP_PATH, baseUrl);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        state: args.state,
        pickup_token: args.pickupToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ConnectError(
      "pickup_failed",
      `Pickup request failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ConnectError(
      "pickup_failed",
      `Pickup returned ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  const json = (await res.json().catch(() => null)) as Partial<PickupResponse> | null;
  if (
    !json ||
    typeof json.treasury_id !== "string" ||
    typeof json.api_key_id !== "string" ||
    typeof json.api_key !== "string"
  ) {
    throw new ConnectError(
      "pickup_failed",
      "Pickup response missing treasury_id / api_key_id / api_key",
    );
  }
  return {
    treasury_id: json.treasury_id,
    api_key_id: json.api_key_id,
    api_key: json.api_key,
  };
}

function requireBaseUrl(): string {
  const baseUrl = process.env.CITIZENPAY_API_BASE_URL;
  if (!baseUrl) {
    throw new ConnectError(
      "no_base_url",
      "CITIZENPAY_API_BASE_URL is not configured",
    );
  }
  return baseUrl;
}
