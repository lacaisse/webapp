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

// A settlement transaction hash the operator records by hand instead of
// minting on-chain: a 0x-prefixed 32-byte hex string. Shared so the Fix dialog
// can gate its confirm button on the same shape the action re-validates.
export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

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

// Previewing existing orders addable to a pending payout over a `[from, to]`
// window on the order's creation date. Same date-only inputs as the create
// dialog (widened to RFC3339 in the action). The range is inclusive on CP's
// side, but we still require from < to for a meaningful window.
export const AddableOrdersRangeSchema = z
  .object({
    payoutId: z.string().min(1, "fund.payments.settlement.errors.addOrdersFailed"),
    from: z.string().regex(DATE, "fund.payments.settlement.errors.rangeInvalid"),
    to: z.string().regex(DATE, "fund.payments.settlement.errors.rangeInvalid"),
  })
  .refine((d) => d.from < d.to, {
    message: "fund.payments.settlement.errors.rangeOrder",
    path: ["to"],
  });

export type AddableOrdersRangeInput = z.infer<typeof AddableOrdersRangeSchema>;

// Adding the selected existing orders to a pending payout. `orderIds` is the
// (non-empty) set the operator kept checked in the preview.
export const AddOrdersSchema = z.object({
  payoutId: z.string().min(1, "fund.payments.settlement.errors.addOrdersFailed"),
  orderIds: z
    .array(z.number().int().positive())
    .min(1, "fund.payments.settlement.errors.noOrdersSelected"),
});

export type AddOrdersInput = z.infer<typeof AddOrdersSchema>;

// Editing a pending payout's settlement window. Dates arrive as `YYYY-MM-DD`
// from <input type="date"> and the action widens them with toRfc3339, exactly
// like creation. Half-open [from, to) — so a payout labelled "July" ends on
// 2026-08-01, and the dialog shows the inclusive last day instead.
//
// Unlike creation, this only relabels: CP claimed the orders when the payout
// was created and keeps them linked, so no total moves and no order joins or
// leaves. That's why there's no place filter here.
export const UpdatePayoutPeriodSchema = z
  .object({
    payoutId: z.string().min(1, "fund.payments.settlement.errors.periodFailed"),
    from: z.string().regex(DATE, "fund.payments.settlement.errors.rangeInvalid"),
    to: z.string().regex(DATE, "fund.payments.settlement.errors.rangeInvalid"),
  })
  .refine((d) => d.from < d.to, {
    message: "fund.payments.settlement.errors.rangeOrder",
    path: ["to"],
  });

export type UpdatePayoutPeriodInput = z.infer<typeof UpdatePayoutPeriodSchema>;

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
