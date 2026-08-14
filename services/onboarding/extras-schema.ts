// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

import { isFieldVisible, type VisibleIf } from "./visibility";

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
  // When set, `required` only applies while the dependency condition holds —
  // a field hidden by its own visibleIf rule can't be enforced. The per-field
  // schema below is built as optional in that case; the object-level
  // superRefine re-applies `required` only for fields currently visible.
  visibleIf?: VisibleIf | null;
};

const REQUIRED = "members.signup.errors.required";
const EMAIL_INVALID = "members.signup.errors.emailInvalid";

export function buildExtrasSchema(fields: ExtraFieldDef[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    shape[field.key] = field.visibleIf
      ? schemaFor({ ...field, required: false })
      : schemaFor(field);
  }
  const base = z.object(shape);

  const conditional = fields.filter((f) => f.visibleIf && f.required);
  if (conditional.length === 0) return base;

  return base.superRefine((data, ctx) => {
    for (const field of conditional) {
      if (!isFieldVisible(field.visibleIf, data)) continue;
      if (isEmpty(data[field.key], field.type)) {
        ctx.addIssue({ code: "custom", message: REQUIRED, path: [field.key] });
      }
    }
  });
}

function isEmpty(value: unknown, type: ExtraFieldDef["type"]): boolean {
  if (value === undefined || value === null) return true;
  if (type === "MULTISELECT") return !Array.isArray(value) || value.length === 0;
  if (type === "CHECKBOX") return value !== true;
  return typeof value !== "string" || value.trim() === "";
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
