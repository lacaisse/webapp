// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Built-in merchant signup fields (per the form spec in the design pass):
//   required: name, address, postalCode, city, country, contactName, email
//   optional: description, website, phone, logoUrl
// Anything beyond this is an OnboardingField extra written to applicationData.

const REQUIRED_TEXT = z.string().min(1);

export const BuiltinMerchantSignupSchema = z.object({
  name: REQUIRED_TEXT.refine((v) => v.trim().length > 0, {
    error: "merchants.signup.errors.nameRequired",
  }),
  description: z.string().optional(),
  contactName: REQUIRED_TEXT.refine((v) => v.trim().length > 0, {
    error: "merchants.signup.errors.contactNameRequired",
  }),
  email: z.string().email({ error: "merchants.signup.errors.emailInvalid" }),
  phone: z.string().optional(),
  website: z.string().optional(),
  logoUrl: z.string().optional(),
  address: REQUIRED_TEXT.refine((v) => v.trim().length > 0, {
    error: "merchants.signup.errors.addressRequired",
  }),
  postalCode: REQUIRED_TEXT.refine((v) => v.trim().length > 0, {
    error: "merchants.signup.errors.postalCodeRequired",
  }),
  city: REQUIRED_TEXT.refine((v) => v.trim().length > 0, {
    error: "merchants.signup.errors.cityRequired",
  }),
  country: REQUIRED_TEXT.refine((v) => v.trim().length > 0, {
    error: "merchants.signup.errors.countryRequired",
  }),
});

export const ExtraValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.boolean(),
]);

export type ExtraValue = z.infer<typeof ExtraValueSchema>;

export const MerchantSignupFormSchema = BuiltinMerchantSignupSchema.extend({
  extras: z.record(z.string(), ExtraValueSchema).optional(),
});

export type BuiltinMerchantSignupInput = z.infer<
  typeof BuiltinMerchantSignupSchema
>;
export type MerchantSignupFormInput = z.infer<typeof MerchantSignupFormSchema>;
