// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import { prisma } from "@/services/db/prisma";
import { loadAccountTransfers } from "@/services/token-account/transfers";
import { PUBLIC_TRANSFER_COUNT } from "./schema";

// Read layer for the public embed widgets. Everything here is rendered on a
// page with no session, framed on somebody else's website, so the rule for
// this file is: build every returned object by picking named fields, never by
// spreading a database row or an internal type. A field that shows up in a
// projection because someone added it upstream is exactly the leak this
// feature has to avoid.
//
// Specifically NEVER serialized to an embed: the account's on-chain address,
// transaction hashes, raw counterparty addresses, Alchemy's `uniqueId`, and
// the annotation's `note` / `trigger` / `triggeredByName` (operator and admin
// names). Merchant contact details and applicationData are equally off-limits.

/**
 * One row of the account widget's activity list. Coarse on purpose: enough for
 * a visitor to see the fund is alive, not enough to trace anyone. `counterparty`
 * is a merchant's public directory name and only ever that — a transfer to or
 * from a member, card, or admin resolves to null rather than to a name.
 */
export type PublicAccountTransfer = {
  direction: "in" | "out" | "self";
  value: string;
  timestamp: string | null;
  kind: "mint" | "burn" | "transfer";
  counterparty: string | null;
};

export type PublicAccountEmbed = {
  balance: string | null;
  tokenSymbol: string | null;
  transfers: PublicAccountTransfer[];
  // True when the chain read failed — the widget shows the balance it has and
  // an "activity unavailable" note rather than an error page.
  transfersError: boolean;
};

export type PublicMerchant = {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  website: string | null;
  conditions: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
};

// The fund columns the account widget needs. Taking a subset (rather than the
// whole Fund row) keeps call sites type-checked against what this actually
// reads, and keeps the encrypted credential columns out of reach entirely.
type EmbedFundContext = {
  id: string;
  tokenAddress: string | null;
  tokenChainId: number | null;
  tokenDecimals: number | null;
  tokenSymbol: string | null;
};

// annotation.kind → the three buckets the public widget distinguishes.
// Anything else (fee sweeps, operator-written CUSTOM labels, no annotation at
// all) collapses to "transfer": the public surface must not expose the fund's
// internal taxonomy, only what a visitor can meaningfully read.
function publicKind(annotationKind: string | null): "mint" | "burn" | "transfer" {
  switch (annotationKind) {
    case "ACCOUNT_MINT":
      return "mint";
    case "ACCOUNT_BURN":
    case "PAYOUT_BURN":
      return "burn";
    default:
      return "transfer";
  }
}

/**
 * The account widget's data for one embed slug, or null when the slug doesn't
 * resolve on this fund.
 *
 * The slug is globally unique and is the only credential the caller presents,
 * so the fund match is re-checked after the lookup: a slug minted on fund A
 * must not render on fund B's host, even though the row exists. Archived
 * accounts stop resolving too — archiving is how an operator retires an
 * account, and it shouldn't keep serving a public widget afterwards.
 */
export async function getPublicAccountEmbed(
  fund: EmbedFundContext,
  slug: string,
): Promise<PublicAccountEmbed | null> {
  const account = await prisma.fundTokenAccount.findUnique({
    where: { embedSlug: slug },
    select: { id: true, fundId: true, address: true, archivedAt: true },
  });
  if (!account || account.fundId !== fund.id || account.archivedAt !== null) {
    return null;
  }

  const [balance, history] = await Promise.all([
    loadBalance(fund, account.address),
    loadPublicTransfers(fund, account.address),
  ]);

  return {
    balance,
    tokenSymbol: fund.tokenSymbol,
    transfers: history.transfers,
    transfersError: history.error,
  };
}

// Balance degrades to null (rendered as "—") rather than throwing: a chain
// hiccup shouldn't blank out somebody's website.
async function loadBalance(
  fund: EmbedFundContext,
  address: string,
): Promise<string | null> {
  if (!fund.tokenAddress || fund.tokenChainId == null) return null;
  try {
    const [bal] = await getBalances({
      chainId: fund.tokenChainId,
      contractAddress: fund.tokenAddress,
      addresses: [address],
    });
    if (!bal) return null;
    return formatTokenAmount(bal.rawBalance, fund.tokenDecimals);
  } catch (e) {
    console.warn("[embed] balance read failed", e);
    return null;
  }
}

async function loadPublicTransfers(
  fund: EmbedFundContext,
  address: string,
): Promise<{ transfers: PublicAccountTransfer[]; error: boolean }> {
  let page;
  try {
    // First page only, then sliced: the widget deliberately has no cursor to
    // page with, which would make it a public export of the whole history.
    page = await loadAccountTransfers(fund.id, fund, address, null);
  } catch (e) {
    console.warn("[embed] transfers read failed", e);
    return { transfers: [], error: true };
  }

  const rows = page.transfers.slice(0, PUBLIC_TRANSFER_COUNT);
  const names = await publicMerchantNamesByAccount(fund.id);

  const transfers = rows.map((tr): PublicAccountTransfer => {
    // The other side of the transfer, resolved to a merchant's public name or
    // to nothing at all. The address itself never leaves this function.
    const other =
      tr.direction === "in"
        ? tr.from
        : tr.direction === "out"
          ? tr.to
          : null;
    return {
      direction: tr.direction,
      value: tr.value,
      timestamp: tr.timestamp,
      kind: publicKind(tr.annotation?.kind ?? null),
      counterparty: other ? (names.get(other.toLowerCase()) ?? null) : null,
    };
  });

  return { transfers, error: false };
}

/**
 * Lowercased place-account → merchant name, for merchants this fund lists
 * publicly. Only ACTIVE + publiclyVisible merchants are in the map, so a
 * hidden or pending merchant's name can never surface as a counterparty.
 *
 * Loads the fund's merchants rather than filtering by the page's addresses:
 * the set is small, and comparing in JS sidesteps the address-casing mismatch
 * between what CitizenPay stored and what Alchemy returns.
 */
async function publicMerchantNamesByAccount(
  fundId: string,
): Promise<Map<string, string>> {
  const merchants = await prisma.merchant.findMany({
    where: {
      fundId,
      status: "ACTIVE",
      publiclyVisible: true,
      citizenPayPlaceAccount: { not: null },
    },
    select: { name: true, citizenPayPlaceAccount: true },
  });
  return new Map(
    merchants
      .filter((m) => m.citizenPayPlaceAccount)
      .map((m) => [m.citizenPayPlaceAccount!.toLowerCase(), m.name]),
  );
}

/**
 * The fund's public merchant directory, for the list and map widgets. Same
 * visibility rule as the {shopList} email variable
 * (services/email/templates.ts::buildShopList): ACTIVE and publiclyVisible.
 *
 * The select is the whole privacy contract of these two widgets — contact
 * name, email, phone, notes, applicationData, review audit and every
 * citizenPay* column stay server-side.
 */
export async function getPublicMerchants(
  fundId: string,
): Promise<PublicMerchant[]> {
  const rows = await prisma.merchant.findMany({
    where: { fundId, status: "ACTIVE", publiclyVisible: true },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      logoUrl: true,
      website: true,
      conditions: true,
      address: true,
      postalCode: true,
      city: true,
      latitude: true,
      longitude: true,
    },
  });
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    logoUrl: m.logoUrl,
    website: m.website,
    conditions: m.conditions,
    address: m.address,
    postalCode: m.postalCode,
    city: m.city,
    latitude: m.latitude,
    longitude: m.longitude,
  }));
}
