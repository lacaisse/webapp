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

export const QuoteConversionSchema = z.object({
  safeId: z.string().min(1),
  converterId: z.string().min(1),
  amount: DECIMAL_AMOUNT,
  slippageBps: SLIPPAGE_BPS.default(DEFAULT_SLIPPAGE_BPS),
});
export type QuoteConversionInput = z.input<typeof QuoteConversionSchema>;

export const StartConversionSchema = QuoteConversionSchema.extend({
  // Raw units of the output asset the user accepted as the minimum (from the
  // quote they were shown). The server posts no less.
  minOut: z.string("fund.safes.conversion.errors.amount").regex(/^\d+$/, "fund.safes.conversion.errors.amount"),
});
export type StartConversionInput = z.input<typeof StartConversionSchema>;

export const ConversionIdSchema = z.object({
  safeId: z.string().min(1),
  conversionId: z.string().min(1),
});
export type ConversionIdInput = z.input<typeof ConversionIdSchema>;
