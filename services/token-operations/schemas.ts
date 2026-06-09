// SPDX-License-Identifier: AGPL-3.0-or-later
// Zod schemas shared between the manual mint/burn forms and the matching
// server actions. Lives outside `admin-actions.ts` because a "use server"
// file can only export async functions — co-located constants/types
// silently turn into server-action proxies and explode at runtime.

import { z } from "zod";

// Standard checksummed-or-lowercase hex address regex. Server actions
// re-validate with `viem.isAddress` to catch invalid checksums.
const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

// Decimal amount string: 1+ integer digits, optional fractional part. The
// server action calls viem `parseUnits(amount, decimals)`; passing more
// fractional digits than the token supports throws, which the action
// surfaces as a user error.
const AMOUNT_REGEX = /^\d+(\.\d+)?$/;

export const ManualMintDirectSchema = z.object({
  to: z.string().regex(ADDRESS_REGEX, {
    error: "tokenOps.errors.addressInvalid",
  }),
  amount: z
    .string()
    .regex(AMOUNT_REGEX, { error: "tokenOps.errors.amountInvalid" })
    .refine((v) => Number(v) > 0, {
      error: "tokenOps.errors.amountPositive",
    }),
});

export const ManualBurnDirectSchema = z.object({
  from: z.string().regex(ADDRESS_REGEX, {
    error: "tokenOps.errors.addressInvalid",
  }),
  amount: z
    .string()
    .regex(AMOUNT_REGEX, { error: "tokenOps.errors.amountInvalid" })
    .refine((v) => Number(v) > 0, {
      error: "tokenOps.errors.amountPositive",
    }),
});

// A required operator annotation, persisted as the transaction's note. Manual
// mint/burn from the /token UI must carry one — it's the audit record of *why*
// the op happened. (Internal callers — account moves, payout/order settlement —
// reuse the actions with their own trigger and don't go through these schemas.)
const requiredNote = z
  .string()
  .trim()
  .min(1, { error: "tokenOps.errors.noteRequired" })
  .max(280, { error: "tokenOps.errors.noteTooLong" });

export const ManualMintFormSchema = ManualMintDirectSchema.extend({
  note: requiredNote,
});
export const ManualBurnFormSchema = ManualBurnDirectSchema.extend({
  note: requiredNote,
});

export type ManualMintDirectInput = z.infer<typeof ManualMintFormSchema>;
export type ManualBurnDirectInput = z.infer<typeof ManualBurnFormSchema>;
