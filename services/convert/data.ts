// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";
import type { FundConversionStatus } from "@/services/db/generated/enums";
import { getDisplayTokens, type DisplayTokensFund } from "@/services/token/display-tokens";

import { formatAmount } from "./amounts";
import { displayTokenAsset } from "./assets";
import { stateOf } from "./progress";
import { converterById } from "./registry";
import { conversionProgress, type ProgressStep } from "./steps";
import type { AssetId, Hex } from "./types";
import type { ConversionView } from "./views";

// Read side for the Safe page: a conversion as the card shows it
// (./views.ts ConversionView), with human amounts (the row stores raw units)
// and the CoW order's uid when one is out. Module map:
// services/convert/assets.ts.

export type { ConversionView } from "./views";

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
    let orderOpen = false;
    let progress: ProgressStep[] = [];
    try {
      const state = stateOf(row);
      orderUid = orderUidOf(state);
      const { legs } = converterById(row.converterId);
      // A swap leg whose order is posted but not filled: its validity still
      // binds what can be continued.
      orderOpen = legs.some((leg, i) => {
        const results = state.legs[i]?.results ?? [];
        return !leg.exact && results.some((r) => r.kind === "api") && !results.some((r) => r.kind === "wait");
      });
      progress = conversionProgress(legs, state, row.status === "DONE");
    } catch {
      // a row with no leg state, or an unregistered converter: nothing to show
    }
    return {
      id: row.id,
      converterId: row.converterId,
      status: row.status,
      round: row.round,
      from: { symbol: from.symbol, amount: formatAmount(BigInt(row.amountIn), from.decimals) },
      to: {
        symbol: to.symbol,
        expected: formatAmount(BigInt(row.expectedOut), to.decimals),
        min: formatAmount(BigInt(row.minOut), to.decimals),
        amount: row.amountOut ? formatAmount(BigInt(row.amountOut), to.decimals) : null,
      },
      orderUid,
      orderOpen,
      progress,
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
