"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { VisibleIf } from "@/services/onboarding/visibility";

// Renders the appropriate input for a per-fund OnboardingField. Used by
// both the member and merchant signup forms. Value is read/written as the
// field's natural type (string for most, string[] for MULTISELECT, boolean
// for CHECKBOX) — the server schema accepts the union.

export type OnboardingFieldType =
  | "TEXT"
  | "TEXTAREA"
  | "EMAIL"
  | "PHONE"
  | "NUMBER"
  | "SELECT"
  | "MULTISELECT"
  | "CHECKBOX"
  | "DATE";

export type OnboardingFieldDef = {
  id: string;
  key: string;
  type: OnboardingFieldType;
  label: string;
  helpText: string | null;
  required: boolean;
  options: { value: string; label: string }[];
  // Set when this field should only render once another field's answer
  // satisfies a comparison — the form component decides whether to render
  // this input at all; see services/onboarding/visibility.ts.
  visibleIf: VisibleIf | null;
};

export type FieldValue = string | string[] | boolean;

export function OnboardingFieldInput({
  field,
  value,
  onChange,
  error,
}: {
  field: OnboardingFieldDef;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
  error?: string;
}) {
  const labelEl = (
    <Label htmlFor={field.id}>
      {field.label}
      {field.required && (
        <span className="ml-1 text-destructive" aria-hidden>
          *
        </span>
      )}
    </Label>
  );
  const help = field.helpText ? (
    <p className="text-xs text-muted-foreground">{field.helpText}</p>
  ) : null;
  const err = error ? (
    <p className="text-sm text-destructive">{error}</p>
  ) : null;

  if (field.type === "TEXTAREA") {
    return (
      <div className="space-y-2">
        {labelEl}
        <textarea
          id={field.id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
          rows={3}
          className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {help}
        {err}
      </div>
    );
  }

  if (field.type === "SELECT") {
    return (
      <div className="space-y-2">
        {labelEl}
        <select
          id={field.id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
          className="h-9 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">—</option>
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {help}
        {err}
      </div>
    );
  }

  if (field.type === "MULTISELECT") {
    const selected = Array.isArray(value) ? value : [];
    const toggle = (optValue: string, checked: boolean) => {
      const next = checked
        ? [...selected, optValue]
        : selected.filter((v) => v !== optValue);
      onChange(next);
    };
    return (
      <div className="space-y-2">
        {labelEl}
        <div className="space-y-1.5 rounded-md bg-background p-2 ring-1 ring-foreground/15">
          {field.options.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={(e) => toggle(opt.value, e.target.checked)}
                className="size-4 rounded border-input"
              />
              {opt.label}
            </label>
          ))}
        </div>
        {help}
        {err}
      </div>
    );
  }

  if (field.type === "CHECKBOX") {
    const checked = value === true;
    return (
      <div className="space-y-1">
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            id={field.id}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            required={field.required}
            className="mt-0.5 size-4 rounded border-input"
          />
          <span>
            {field.label}
            {field.required && (
              <span className="ml-1 text-destructive" aria-hidden>
                *
              </span>
            )}
          </span>
        </label>
        {help}
        {err}
      </div>
    );
  }

  // Default: TEXT / EMAIL / PHONE / NUMBER / DATE — single-line Input with
  // the right HTML5 type so mobile keyboards and pickers behave.
  return (
    <div className="space-y-2">
      {labelEl}
      <Input
        id={field.id}
        type={htmlTypeFor(field.type)}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        required={field.required}
      />
      {help}
      {err}
    </div>
  );
}

function htmlTypeFor(t: OnboardingFieldType): string {
  switch (t) {
    case "EMAIL":
      return "email";
    case "PHONE":
      return "tel";
    case "NUMBER":
      return "number";
    case "DATE":
      return "date";
    default:
      return "text";
  }
}
