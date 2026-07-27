// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { updateMemberApplicationDataAction } from "@/services/member/application-data-actions";
import type { ExtraValue } from "@/services/member/schema";
import {
  OnboardingFieldInput,
  type FieldValue,
  type OnboardingFieldDef,
} from "@/app/(fund-public)/onboarding-field-input";

// Edits a member's answers to the fund's custom signup questions. Renders the
// exact same inputs the public form uses, so an admin sees the question the
// way the applicant did.
//
// Only fields the fund still asks (non-archived) are editable; answers to
// archived questions stay visible on the detail page and are preserved
// untouched by the action.

export function EditApplicationDataDialog({
  memberId,
  fields,
  values,
}: {
  memberId: string;
  fields: OnboardingFieldDef[];
  values: Record<string, ExtraValue>;
}) {
  const t = useTranslations("fund.members.detail.applicationData");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, FieldValue>>(() =>
    initialDraft(fields, values),
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setDraft(initialDraft(fields, values));
    setError(null);
    setFieldErrors({});
  };

  const onSubmit = () => {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await updateMemberApplicationDataAction({
        memberId,
        values: draft as Record<string, ExtraValue>,
      });
      if ("error" in result) {
        if (result.field) setFieldErrors({ [result.field]: result.error });
        else setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            <Pencil />
            {t("edit")}
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editTitle")}</DialogTitle>
          <DialogDescription>{t("editDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {fields.map((field) => (
            <OnboardingFieldInput
              key={field.id}
              field={field}
              value={draft[field.key]}
              onChange={(v) =>
                setDraft((prev) => ({ ...prev, [field.key]: v }))
              }
              error={
                fieldErrors[field.key]
                  ? translate(tRoot, fieldErrors[field.key])
                  : undefined
              }
            />
          ))}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The action returns already-translated strings; this only catches the case
// where a raw i18n key slips through.
function translate(tRoot: ReturnType<typeof useTranslations>, msg: string) {
  return msg.startsWith("members.") ? tRoot(msg as never) : msg;
}

function initialDraft(
  fields: OnboardingFieldDef[],
  values: Record<string, ExtraValue>,
): Record<string, FieldValue> {
  return Object.fromEntries(
    fields.map((f) => [f.key, values[f.key] ?? defaultValueFor(f)]),
  );
}

function defaultValueFor(field: OnboardingFieldDef): FieldValue {
  if (field.type === "MULTISELECT") return [];
  if (field.type === "CHECKBOX") return false;
  return "";
}
