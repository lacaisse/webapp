// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConversionQuote } from "./engine";
import type { PreparedHttp } from "./types";

// Result types of the conversion server actions (admin-actions.ts). Kept
// out of the "use server" file, which may only export async functions.
// Starting / continuing a conversion answers like a Safe proposal
// (services/safe/action-types.ts ProposeActionResult): the dialog runs the
// same signing ceremony.

// Null request: the quote calls nothing outside, quote without a relay.
export type PrepareQuoteResult = { error: string } | { ok: true; request: PreparedHttp | null };
export type QuoteActionResult = { error: string } | { ok: true; quote: ConversionQuote };
export type CancelConversionResult = { error: string } | { ok: true };
