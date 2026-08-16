// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { FeeCollectionFrequency } from "@/services/db/generated/enums";

import {
  treasury as treasuryApi,
  type CitizenPayApiCredentials,
  type TreasuryWire,
} from "./api";

// Fetch the connected treasury's token info from CP and normalise it into
// our `Fund.token*` columns. Called from `consumeConnect` immediately after
// a successful pickup (best-effort — credentials still persist if this
// fails; a follow-up rotate or a periodic sync can refresh later).
//
// All token-related columns on `Fund` are caches of CP truth:
//   tokenAddress, tokenDecimals, tokenName, tokenSymbol, tokenChainId.
// We do NOT expose these as editable in the UI.
//
// The one EXCEPTION is the fee pair `payoutFeePercentage` /
// `feeCollectionFrequency`: those values are canonical on our side (admin sets
// them in settings → we push them to CP). We surface CP's echo here only so
// the caller can reconcile (confirm sync / seed) — it must NOT blindly
// overwrite a locally-set fee or cadence. See consumeConnect in connect.ts.

const CHAIN_IDS: Record<string, number> = {
  gnosis: 100,
  polygon: 137,
  base: 8453,
  optimism: 10,
  arbitrum: 42161,
  mainnet: 1,
};

export type TokenInfo = {
  tokenAddress: string | null;
  tokenChainId: number | null;
  tokenDecimals: number | null;
  tokenName: string | null;
  tokenSymbol: string | null;
  tokenLogoUrl: string | null;
  // 4337 stack — entrypoint / factory / paymaster CP wants us to use for
  // this treasury. Cached on Fund and read by services/token/userop.ts
  // (no env-var indirection).
  citizenPayEntrypointAddress: string | null;
  citizenPayAccountFactoryAddress: string | null;
  citizenPayPaymasterAddress: string | null;
  citizenPayPaymasterType: string | null;
  // Treasury slug — the `network` segment of a card's public tap URL.
  citizenPayTreasurySlug: string | null;
  // CP's echo of the platform fee, normalised to a 2-decimal percent string
  // (e.g. "2.50"). Canonical on our side — reconciled, not cached. See header.
  payoutFeePercentage: string | null;
  // CP's echo of the fee collection cadence, normalised to the Prisma
  // `FeeCollectionFrequency` spelling. Null when CP reports nothing (or
  // something we don't recognise). Same reconcile-don't-cache rule as above.
  feeCollectionFrequency: FeeCollectionFrequency | null;
};

/**
 * Pull the treasury's token info from CP. Tolerant of both flat and nested
 * (`token: { ... }`) shapes since CP's exact response isn't documented yet
 * — see the `TreasuryWire` TODO in api.ts.
 *
 * Returns null on any HTTP / parse failure so the caller can fall through
 * without breaking the credentials write. Errors are logged here, not
 * thrown.
 */
export async function fetchTokenInfo(
  creds: CitizenPayApiCredentials,
): Promise<TokenInfo | null> {
  let wire: TreasuryWire;
  try {
    wire = await treasuryApi.get(creds);
  } catch (e) {
    console.warn(
      "[citizenpay-sync] treasury.get failed; skipping token cache",
      e,
    );
    return null;
  }
  return normaliseTreasury(wire);
}

function normaliseTreasury(wire: TreasuryWire): TokenInfo {
  // Prefer nested `token.*` if present, fall back to top-level fields.
  const t = wire.token ?? {};
  const tokenAddress = t.address ?? wire.token_address ?? null;
  const tokenName = t.name ?? wire.name ?? null;
  const tokenSymbol = t.symbol ?? wire.symbol ?? null;
  const tokenLogoUrl = t.logo ?? wire.logo ?? null;
  const decimalsRaw = t.decimals ?? wire.decimals;
  const tokenDecimals =
    typeof decimalsRaw === "number" && Number.isFinite(decimalsRaw)
      ? decimalsRaw
      : null;

  const chainRaw = (t.chain ?? wire.chain ?? "").toString().toLowerCase().trim();
  let tokenChainId: number | null = null;
  if (chainRaw) {
    const mapped = CHAIN_IDS[chainRaw];
    if (mapped !== undefined) {
      tokenChainId = mapped;
    } else {
      console.warn(
        `[citizenpay-sync] unknown chain "${chainRaw}" — leaving tokenChainId unchanged`,
      );
    }
  }

  // Fee: prefer integer basis points (what we send), fall back to a decimal
  // percent. Normalise to a 2-decimal percent string for the Fund column.
  let payoutFeePercentage: string | null = null;
  if (typeof wire.fee_percentage_bps === "number" && Number.isFinite(wire.fee_percentage_bps)) {
    payoutFeePercentage = (wire.fee_percentage_bps / 100).toFixed(2);
  } else if (typeof wire.fee_percentage === "number" && Number.isFinite(wire.fee_percentage)) {
    payoutFeePercentage = wire.fee_percentage.toFixed(2);
  }

  // Cadence: snake_case preferred, camelCase accepted (CP hasn't confirmed
  // the field name). Anything we don't recognise reads as "CP said nothing"
  // so the caller leaves the local value alone.
  const frequencyRaw = (wire.fee_collection_frequency ?? wire.feeCollectionFrequency ?? "")
    .toString()
    .toLowerCase()
    .trim();
  let feeCollectionFrequency: FeeCollectionFrequency | null = null;
  if (frequencyRaw === "monthly") {
    feeCollectionFrequency = "MONTHLY";
  } else if (frequencyRaw === "per_payment") {
    feeCollectionFrequency = "PER_PAYMENT";
  } else if (frequencyRaw) {
    console.warn(
      `[citizenpay-sync] unknown fee collection frequency "${frequencyRaw}" — leaving the local value unchanged`,
    );
  }

  return {
    tokenAddress,
    tokenChainId,
    tokenDecimals,
    tokenName,
    tokenSymbol,
    tokenLogoUrl,
    citizenPayEntrypointAddress: wire.entrypoint_address ?? null,
    citizenPayAccountFactoryAddress: wire.account_factory_address ?? null,
    citizenPayPaymasterAddress: wire.paymaster_address ?? null,
    citizenPayPaymasterType: wire.paymaster_type ?? null,
    citizenPayTreasurySlug: wire.slug ?? null,
    payoutFeePercentage,
    feeCollectionFrequency,
  };
}
