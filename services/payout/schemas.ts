// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared (non-"use server") schemas for the payout flow so both the dialog
// and the server actions validate the same shape. Date inputs arrive as
// `YYYY-MM-DD` (from <input type="date">); the action widens them to RFC3339
// before calling CitizenPay. The range is half-open [from, to).
import { z } from "zod";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const PayoutRangeSchema = z
  .object({
    placeId: z.string().min(1, "fund.payments.settlement.errors.createFailed"),
    from: z.string().regex(DATE, "fund.payments.settlement.errors.rangeInvalid"),
    to: z.string().regex(DATE, "fund.payments.settlement.errors.rangeInvalid"),
  })
  .refine((d) => d.from < d.to, {
    message: "fund.payments.settlement.errors.rangeOrder",
    path: ["to"],
  });

export type PayoutRangeInput = z.infer<typeof PayoutRangeSchema>;

/** `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00Z` (RFC3339, UTC midnight). */
export function toRfc3339(date: string): string {
  return `${date}T00:00:00Z`;
}

// Manually adding an order to a pending payout. Amounts arrive as decimal
// strings from <input type="number"> (e.g. "28.32") — up to 2dp. The action
// passes them straight to the client, which converts to cents. `description`
// is the bank-transfer reference (bank-transaction mode) or free text.
const MONEY = /^\d+(\.\d{1,2})?$/;

export const CreatePayoutOrderSchema = z
  .object({
    payoutId: z.string().min(1, "fund.payments.settlement.errors.createOrderFailed"),
    total: z.string().regex(MONEY, "fund.payments.settlement.errors.amountInvalid"),
    fees: z.string().regex(MONEY, "fund.payments.settlement.errors.feeInvalid"),
    description: z
      .string()
      .trim()
      .max(500, "fund.payments.settlement.errors.descriptionTooLong")
      .optional()
      .nullable(),
  })
  .refine((d) => Number(d.total) > 0, {
    message: "fund.payments.settlement.errors.amountPositive",
    path: ["total"],
  })
  .refine((d) => Number(d.fees) <= Number(d.total), {
    message: "fund.payments.settlement.errors.feeTooHigh",
    path: ["fees"],
  });

export type CreatePayoutOrderFormInput = z.infer<typeof CreatePayoutOrderSchema>;

// Setting a payout's manual deduction. `amount` is a EUR decimal string (up to
// 2dp); "0" clears the deduction. `comment` is an optional short note. The
// upper bound (≤ total − fees) is enforced in the action, which has the
// payout's totals; here we only validate shape.
export const SetManualDeductionSchema = z.object({
  payoutId: z.string().min(1, "fund.payments.settlement.errors.deductionFailed"),
  amount: z.string().regex(MONEY, "fund.payments.settlement.errors.amountInvalid"),
  comment: z
    .string()
    .trim()
    .max(500, "fund.payments.settlement.errors.descriptionTooLong")
    .optional()
    .nullable(),
});

export type SetManualDeductionFormInput = z.infer<
  typeof SetManualDeductionSchema
>;
