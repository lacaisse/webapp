// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getDisplayTokens, type DisplayTokensFund } from "@/services/token/display-tokens";
import type { ExtraToken } from "@/services/token/extra-tokens";

import { GNOSIS_ASSETS, displayTokenAsset } from "./assets";
import { breadBurn, breadMint } from "./legs/bread";
import { cowLeg } from "./legs/cow";
import { ConvertError, type AssetId, type Converter } from "./types";
import { assertConverter } from "./walk";

// The converters La Caisse offers. A converter is an id (stored on rows:
// never rename) and its legs in order; adding a pair whose legs exist is one
// line here. Server-only because the CoW leg is. Module map:
// services/convert/assets.ts.

export const CONVERTERS: readonly Converter[] = [
  // EURe → BREAD: sell EURe for WXDAI on CoW (one proposal: approve +
  // presign), then unwrap + mint (a second proposal, sized to the fill).
  { id: "eure-bread", legs: [cowLeg(GNOSIS_ASSETS.EURE, GNOSIS_ASSETS.WXDAI), breadMint] },
  // BREAD → EURe: burn + wrap fold into the swap's batch — one proposal.
  { id: "bread-eure", legs: [breadBurn, cowLeg(GNOSIS_ASSETS.WXDAI, GNOSIS_ASSETS.EURE)] },
];
// A converter the engine could not run fails here, at load, not on a click.
CONVERTERS.forEach(assertConverter);

export function converterFrom(c: Converter): AssetId {
  return c.legs[0].from;
}

export function converterTo(c: Converter): AssetId {
  return c.legs[c.legs.length - 1].to;
}

export function converterById(id: string): Converter {
  const c = CONVERTERS.find((x) => x.id === id);
  if (!c) throw new ConvertError("not_found", `Unknown converter ${id}`);
  return c;
}

export function findConverter(from: AssetId, to: AssetId): Converter | null {
  return CONVERTERS.find((c) => converterFrom(c) === from && converterTo(c) === to) ?? null;
}

export type OfferedPair = {
  converter: Converter;
  from: ExtraToken; // the fund's display token the input is
  to: ExtraToken;
};

/**
 * The conversions a fund can start: a registered converter whose two ends
 * are both tokens the fund shows (Settings → Token). No fund setting of its
 * own — adding BREAD as a custom token is what turns EURe ↔ BREAD on.
 */
export async function offeredPairs(fund: DisplayTokensFund): Promise<OfferedPair[]> {
  const tokens = await getDisplayTokens(fund);
  const byAsset = new Map(tokens.map((t) => [displayTokenAsset(t, fund.tokenChainId), t]));
  const pairs: OfferedPair[] = [];
  for (const converter of CONVERTERS) {
    const from = byAsset.get(converterFrom(converter));
    const to = byAsset.get(converterTo(converter));
    if (from && to) pairs.push({ converter, from, to });
  }
  return pairs;
}
