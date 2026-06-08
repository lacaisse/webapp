// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared (non-"use server") schemas for fund token accounts, so the dialogs
// and the server actions validate the same shape. Messages are i18n keys
// resolved by the caller. Amounts are decimal strings — precise validation
// (against the token's decimals) happens in the reused mint/burn actions.
import { z } from "zod";

const NAME = z
  .string()
  .trim()
  .min(1, "fund.accounts.errors.nameRequired")
  .max(80, "fund.accounts.errors.nameTooLong");

export const CreateTokenAccountSchema = z.object({ name: NAME });

export const RenameTokenAccountSchema = z.object({
  id: z.string().min(1, "fund.accounts.errors.notFound"),
  name: NAME,
});

const DECIMAL = /^\d+(\.\d+)?$/;

export const MoveTokensSchema = z
  .object({
    id: z.string().min(1, "fund.accounts.errors.notFound"),
    amount: z.string().regex(DECIMAL, "fund.accounts.errors.amountInvalid"),
  })
  .refine((d) => Number(d.amount) > 0, {
    message: "fund.accounts.errors.amountPositive",
    path: ["amount"],
  });

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export const TransferTokensSchema = z
  .object({
    id: z.string().min(1, "fund.accounts.errors.notFound"),
    to: z.string().trim().regex(ADDRESS, "fund.accounts.errors.addressInvalid"),
    amount: z.string().regex(DECIMAL, "fund.accounts.errors.amountInvalid"),
  })
  .refine((d) => Number(d.amount) > 0, {
    message: "fund.accounts.errors.amountPositive",
    path: ["amount"],
  });

export type CreateTokenAccountInput = z.infer<typeof CreateTokenAccountSchema>;
export type MoveTokensInput = z.infer<typeof MoveTokensSchema>;
export type TransferTokensInput = z.infer<typeof TransferTokensSchema>;
