// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Zod schemas shared by the conversion dialog (client validation) and the
// server actions in services/convert/admin-actions.ts. Messages are i18n
// keys under `fund.safes.errors.*`, resolved by the caller.

const DECIMAL_AMOUNT = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "fund.safes.errors.amountInvalid")
  .refine((v) => Number(v) > 0, "fund.safes.errors.amountInvalid");

// Basis points: 0.01 % … 3 %.
const SLIPPAGE_BPS = z.number().int().min(1).max(300);

export const QuoteConversionSchema = z.object({
  safeId: z.string().min(1),
  converterId: z.string().min(1),
  amount: DECIMAL_AMOUNT,
  slippageBps: SLIPPAGE_BPS.default(50),
});
export type QuoteConversionInput = z.input<typeof QuoteConversionSchema>;

export const StartConversionSchema = QuoteConversionSchema.extend({
  // Raw units of the output asset the user accepted as the minimum (from the
  // quote they were shown). The server posts no less.
  minOut: z.string().regex(/^\d+$/),
});
export type StartConversionInput = z.input<typeof StartConversionSchema>;

export const ConversionIdSchema = z.object({
  safeId: z.string().min(1),
  conversionId: z.string().min(1),
});
export type ConversionIdInput = z.input<typeof ConversionIdSchema>;
