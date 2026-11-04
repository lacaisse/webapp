// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Zod schemas shared by the conversion dialog (client validation) and the
// server actions in services/convert/admin-actions.ts. Messages are i18n
// keys (`fund.safes.errors.*`, `fund.safes.conversion.errors.*`), resolved
// by the caller.

const DECIMAL_AMOUNT = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "fund.safes.errors.amountInvalid")
  .refine((v) => Number(v) > 0, "fund.safes.errors.amountInvalid");

// The slippage policy, in one place: what the dialog asks for, and the most
// the server accepts.
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 300;

// Basis points: 0.01 % … 3 %. The dialog never sends anything else, so a
// refusal here is a client at fault, not a person: the generic Safe error.
const UNKNOWN = "fund.safes.errors.unknown";
const SLIPPAGE_BPS = z.number(UNKNOWN).int(UNKNOWN).min(1, UNKNOWN).max(MAX_SLIPPAGE_BPS, UNKNOWN);

// What the browser brings back from the quote request the server prepared
// (prepareQuoteAction → services/convert/browser-quote.ts): an HTTP status
// and the body, which the server parses and checks itself. Size-capped: a
// quote is under a kilobyte, and the browser cuts anything longer (an error
// page) to the cap before sending.
export const RELAYED_TEXT_MAX = 16_384;
export const RelayedHttpSchema = z.object({
  status: z.number(UNKNOWN).int(UNKNOWN).min(100, UNKNOWN).max(599, UNKNOWN),
  text: z.string(UNKNOWN).max(RELAYED_TEXT_MAX, UNKNOWN),
});

export const QuoteConversionSchema = z.object({
  safeId: z.string().min(1),
  converterId: z.string().min(1),
  amount: DECIMAL_AMOUNT,
  slippageBps: SLIPPAGE_BPS.default(DEFAULT_SLIPPAGE_BPS),
  relayed: RelayedHttpSchema.optional(),
});
export type QuoteConversionInput = z.input<typeof QuoteConversionSchema>;

export const StartConversionSchema = QuoteConversionSchema.extend({
  // Raw units of the output asset the user accepted as the minimum (from the
  // quote they were shown). The server posts no less.
  minOut: z.string("fund.safes.conversion.errors.amount").regex(/^\d+$/, "fund.safes.conversion.errors.amount"),
});
export type StartConversionInput = z.input<typeof StartConversionSchema>;

// Finishing a start the browser carried the order post for: the sealed
// ticket the start action handed out, and the orderbook's answer.
export const CompleteStartSchema = z.object({
  safeId: z.string().min(1),
  ticket: z.string(UNKNOWN).min(1, UNKNOWN).max(65_536, UNKNOWN),
  relayed: RelayedHttpSchema.optional(),
});
export type CompleteStartInput = z.input<typeof CompleteStartSchema>;

export const ConversionIdSchema = z.object({
  safeId: z.string().min(1),
  conversionId: z.string().min(1),
});
export type ConversionIdInput = z.input<typeof ConversionIdSchema>;
