// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FundConversionStatus } from "@/services/db/generated/enums";

import type { ProgressStep } from "./steps";
import type { Hex } from "./types";

export type { ProgressStep } from "./steps";

// What the Safe page shows of a conversion. Pure (no server-only): the
// client cards import the type and the link helper; services/convert/data.ts
// builds the rows. Module map: services/convert/assets.ts.

export type ConversionView = {
  id: string;
  converterId: string;
  status: FundConversionStatus;
  round: number;
  from: { symbol: string; amount: string }; // human amounts
  to: { symbol: string; expected: string; min: string; amount: string | null };
  orderUid: Hex | null; // the CoW order of the swap leg, once posted
  progress: ProgressStep[]; // every step of the conversion, done / active / pending
  validUntil: string | null; // ISO
  errorMessage: string | null;
  createdAt: string; // ISO
  completedAt: string | null;
  createdBy: { id: string; name: string | null } | null;
};

/** CoW Explorer page of an order (Gnosis = "gc"); null on a chain it does not cover. */
export function cowExplorerOrderUrl(chainId: number, uid: Hex): string | null {
  const net = chainId === 100 ? "gc" : null;
  return net ? `https://explorer.cow.fi/${net}/orders/${uid}` : null;
}
