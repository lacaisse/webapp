// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Builds a Zod schema for a fund's custom signup fields from their runtime
// definitions, so the client can enforce `required` per field.
//
// This exists for the multi-step form: "Next" must refuse to advance past a
// page with an unanswered required question, and the static SignupFormSchema
// can't know which questions a given fund asks. It is a UX guard only —
// signupMemberAction re-checks every `required` field server-side against the
// DB definitions, which is the actual enforcement (see services/member/actions.ts).
//
// Messages are i18n keys, resolved by the form via the root translator.

export type ExtraFieldDef = {
  key: string;
  type:
    | "TEXT"
    | "TEXTAREA"
    | "EMAIL"
    | "PHONE"
    | "NUMBER"
    | "SELECT"
    | "MULTISELECT"
    | "CHECKBOX"
    | "DATE";
  required: boolean;
};

const REQUIRED = "members.signup.errors.required";
const EMAIL_INVALID = "members.signup.errors.emailInvalid";

export function buildExtrasSchema(fields: ExtraFieldDef[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    shape[field.key] = schemaFor(field);
  }
  return z.object(shape);
}

function schemaFor(field: ExtraFieldDef): z.ZodType {
  switch (field.type) {
    case "CHECKBOX":
      // A required checkbox is a consent gate: it must actually be ticked.
      return field.required
        ? z.literal(true, { error: REQUIRED })
        : z.boolean().optional();

    case "MULTISELECT": {
      const base = z.array(z.string());
      return field.required
        ? base.min(1, { error: REQUIRED })
        : base.optional();
    }

    case "EMAIL": {
      // Empty is fine when optional; a non-empty value must still look like
      // an address, otherwise the visitor gets a server error at the end.
      const base = z.string().trim();
      return field.required
        ? base.min(1, { error: REQUIRED }).pipe(z.email({ error: EMAIL_INVALID }))
        : z.union([z.literal(""), base.pipe(z.email({ error: EMAIL_INVALID }))]).optional();
    }

    default: {
      const base = z.string().trim();
      return field.required ? base.min(1, { error: REQUIRED }) : base.optional();
    }
  }
}
