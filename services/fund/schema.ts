import { z } from "zod";

// For the free tier, users pick a subdomain prefix (e.g. "acme") and we
// store the full domain ("acme.lacaisse.eu") in `Fund.domain`. Reserved
// subdomains can never be a fund — they collide with apex routes or infra.
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "mail",
  "login",
  "signup",
  "auth",
  "new",
  "account",
  "billing",
  "support",
  "help",
  "docs",
  "blog",
  "status",
]);

export const SUBDOMAIN_MIN_LENGTH = 3;
export const SUBDOMAIN_MAX_LENGTH = 63;
export const NAME_MIN_LENGTH = 2;

// Error messages are translation KEYS — clients call t() at display time,
// the action calls getTranslations() server-side to translate before
// returning to forms.
export const CreateFundSchema = z.object({
  name: z.string().min(NAME_MIN_LENGTH, {
    error: "funds.create.errors.nameMin",
  }),
  subdomain: z
    .string()
    .min(SUBDOMAIN_MIN_LENGTH, { error: "funds.create.errors.subdomainMin" })
    .max(SUBDOMAIN_MAX_LENGTH, { error: "funds.create.errors.subdomainMax" })
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
      error: "funds.create.errors.subdomainFormat",
    })
    .refine((s) => !RESERVED_SUBDOMAINS.has(s), {
      error: "funds.create.errors.subdomainReserved",
    }),
});
export type CreateFundInput = z.infer<typeof CreateFundSchema>;
