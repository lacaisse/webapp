// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { formatUnits } from "viem";

import { prisma } from "@/services/db/prisma";
import type { FundConversionStatus } from "@/services/db/generated/enums";
import { getDisplayTokens, type DisplayTokensFund } from "@/services/token/display-tokens";

import { displayTokenAsset } from "./assets";
import { stateOf } from "./progress";
import type { AssetId, Hex } from "./types";

// Read side for the Safe page: a conversion as the card shows it, with
// human amounts (the row stores raw units) and the CoW order's uid when one
// is out. Module map: services/convert/assets.ts.

export type ConversionView = {
  id: string;
  converterId: string;
  status: FundConversionStatus;
  round: number;
  from: { symbol: string; amount: string };
  to: { symbol: string; expected: string; min: string; amount: string | null };
  orderUid: Hex | null; // the CoW order of the swap leg, once posted
  validUntil: string | null; // ISO
  errorMessage: string | null;
  createdAt: string; // ISO
  completedAt: string | null;
  createdBy: { id: string; name: string | null } | null;
};

const OPEN: FundConversionStatus[] = ["PROPOSED", "READY", "FILLING"];
const RECENT_CLOSED = 5;

function orderUidOf(state: ReturnType<typeof stateOf>): Hex | null {
  for (const leg of state.legs) {
    const api = leg.results.find((r) => r.kind === "api");
    if (api && api.kind === "api" && api.ref.startsWith("0x")) return api.ref as Hex;
  }
  return null;
}

/**
 * The Safe's open conversions (oldest first), then its last few finished
 * ones (newest first), for the conversions card.
 */
export async function listSafeConversions(
  fund: DisplayTokensFund,
  safeId: string,
): Promise<ConversionView[]> {
  const [open, closed, tokens] = await Promise.all([
    prisma.fundConversion.findMany({
      where: { fundId: fund.id, safeId, status: { in: OPEN } },
      orderBy: { createdAt: "asc" },
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    }),
    prisma.fundConversion.findMany({
      where: { fundId: fund.id, safeId, status: { notIn: OPEN } },
      orderBy: { completedAt: "desc" },
      take: RECENT_CLOSED,
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    }),
    getDisplayTokens(fund),
  ]);
  const byAsset = new Map<AssetId, { symbol: string; decimals: number }>(
    tokens.map((t) => [displayTokenAsset(t, fund.tokenChainId), { symbol: t.symbol, decimals: t.decimals }]),
  );
  const meta = (asset: string) =>
    byAsset.get(asset as AssetId) ?? { symbol: asset.slice(asset.lastIndexOf(":") + 1, asset.lastIndexOf(":") + 7), decimals: 18 };
  return [...open, ...closed].map((row) => {
    const from = meta(row.fromAsset);
    const to = meta(row.toAsset);
    let orderUid: Hex | null = null;
    try {
      orderUid = orderUidOf(stateOf(row));
    } catch {
      // a row with no leg state: nothing to link
    }
    return {
      id: row.id,
      converterId: row.converterId,
      status: row.status,
      round: row.round,
      from: { symbol: from.symbol, amount: formatUnits(BigInt(row.amountIn), from.decimals) },
      to: {
        symbol: to.symbol,
        expected: formatUnits(BigInt(row.expectedOut), to.decimals),
        min: formatUnits(BigInt(row.minOut), to.decimals),
        amount: row.amountOut ? formatUnits(BigInt(row.amountOut), to.decimals) : null,
      },
      orderUid,
      validUntil: row.validUntil?.toISOString() ?? null,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      createdBy: row.createdBy
        ? { id: row.createdBy.id, name: row.createdBy.name?.trim() || row.createdBy.email }
        : null,
    };
  });
}

/** CoW Explorer page of an order (Gnosis = "gc"). */
export function cowExplorerOrderUrl(chainId: number, uid: Hex): string | null {
  const net = chainId === 100 ? "gc" : null;
  return net ? `https://explorer.cow.fi/${net}/orders/${uid}` : null;
}
