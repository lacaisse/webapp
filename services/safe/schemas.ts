// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

import type { ExtraTokenKey } from "@/services/token/extra-tokens";

// Zod schemas shared by the Safe dialogs (client validation) and the server
// actions in services/safe/admin-actions.ts (re-validation). Messages are
// i18n keys under `fund.safes.errors.*`, resolved by the caller.

// Unicode format characters (category Cf): bidi overrides / isolates
// (U+202A–U+202E, U+2066–U+2069), zero-width space / joiners (U+200B–U+200D),
// soft hyphen, BOM… They are invisible, so a proposer could use them to make a
// label or note read differently from what it says (e.g. reversing an address
// fragment with U+202E). Stripped, then trimmed, before any length check.
const INVISIBLE = /\p{Cf}/gu;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, "").trim();
}

// Free text typed by a proposer: invisible characters stripped and trimmed,
// THEN length-checked (so the cap applies to what is actually shown).
const cleanText = (max: number, message?: string) =>
  z.string().transform(stripInvisible).pipe(z.string().max(max, message));

const NAME = z
  .string()
  .transform(stripInvisible)
  .pipe(
    z
      .string()
      .min(1, "fund.safes.errors.nameRequired")
      .max(60, "fund.safes.errors.nameTooLong"),
  );

export const ADDRESS = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, "fund.safes.errors.addressInvalid");

const DECIMAL_AMOUNT = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "fund.safes.errors.amountInvalid")
  .refine((v) => Number(v) > 0, "fund.safes.errors.amountInvalid");

const THRESHOLD = z
  .number()
  .int()
  .min(1, "fund.safes.errors.thresholdInvalid");

export const ExternalOwnerSchema = z.object({
  address: ADDRESS,
  label: cleanText(60, "fund.safes.errors.labelTooLong"),
});

export const CreateSafeSchema = z
  .object({
    name: NAME,
    memberUserIds: z.array(z.string().min(1)).max(20),
    externalOwners: z.array(ExternalOwnerSchema).max(20),
    threshold: THRESHOLD,
  })
  .refine(
    (v) => v.memberUserIds.length + v.externalOwners.length >= 1,
    { message: "fund.safes.errors.ownersRequired", path: ["threshold"] },
  )
  .refine(
    (v) => v.threshold <= v.memberUserIds.length + v.externalOwners.length,
    { message: "fund.safes.errors.thresholdTooHigh", path: ["threshold"] },
  );
export type CreateSafeInput = z.infer<typeof CreateSafeSchema>;

export const RenameSafeSchema = z.object({ safeId: z.string().min(1), name: NAME });

export const SafeIdSchema = z.object({ safeId: z.string().min(1) });

export const SafeTxIdSchema = z.object({
  safeId: z.string().min(1),
  transactionId: z.string().min(1),
});

// Which of the Safe's balances a transfer moves: the fund token, or one of the
// display tokens the fund shows (services/token/extra-tokens.ts — xDAI is
// "native", a plain value transfer; a fund-registered ERC-20 is
// `custom:<lowercased address>`). Whether the fund actually shows that token
// is checked server-side. Decimal caps are enforced server-side per token (2
// for the fund token: TokenOperation.amount is Decimal(12,2)).
export const TRANSFER_TOKENS = ["fund", "native", "eure"] as const;
export type TransferToken = "fund" | ExtraTokenKey;

const TRANSFER_TOKEN_RE = /^(?:fund|native|eure|custom:0x[0-9a-f]{40})$/;

const TRANSFER_TOKEN = z
  .string()
  .regex(TRANSFER_TOKEN_RE, "fund.safes.errors.tokenNotEnabled")
  .transform((v) => v as TransferToken);

export const ProposeTransferSchema = z.object({
  safeId: z.string().min(1),
  recipient: ADDRESS,
  amount: DECIMAL_AMOUNT,
  token: TRANSFER_TOKEN.default("fund"),
  recipientLabel: cleanText(80).optional(),
  note: cleanText(200, "fund.safes.errors.noteTooLong").optional(),
});
// Input (token optional, defaults to "fund") — what callers pass; the core
// reads `token ?? "fund"`.
export type ProposeTransferInput = Omit<z.input<typeof ProposeTransferSchema>, "token"> & {
  token?: TransferToken;
};

// Owner / threshold changes. A new owner is either a fund member (we create
// or reuse their FundSigner) or an external address with a label.
const NewOwnerFields = {
  memberUserId: z.string().min(1).optional(),
  address: ADDRESS.optional(),
  label: cleanText(60, "fund.safes.errors.labelTooLong").optional(),
};
const hasOneNewOwner = (v: { memberUserId?: string; address?: string }) =>
  Boolean(v.memberUserId) !== Boolean(v.address);

export const OwnerChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("ADD_OWNER"), threshold: THRESHOLD, ...NewOwnerFields })
    .refine(hasOneNewOwner, { message: "fund.safes.errors.ownerRequired", path: ["address"] }),
  z.object({ kind: z.literal("REMOVE_OWNER"), address: ADDRESS, threshold: THRESHOLD }),
  z
    .object({ kind: z.literal("SWAP_OWNER"), oldOwner: ADDRESS, ...NewOwnerFields })
    .refine(hasOneNewOwner, { message: "fund.safes.errors.ownerRequired", path: ["address"] }),
  z.object({ kind: z.literal("CHANGE_THRESHOLD"), threshold: THRESHOLD }),
]);
export type OwnerChangeInput = z.infer<typeof OwnerChangeSchema>;

export const ProposeOwnerChangeSchema = z.object({
  safeId: z.string().min(1),
  change: OwnerChangeSchema,
  note: cleanText(200, "fund.safes.errors.noteTooLong").optional(),
});
export type ProposeOwnerChangeInput = z.infer<typeof ProposeOwnerChangeSchema>;
