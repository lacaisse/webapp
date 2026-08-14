"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  archiveOnboardingFieldAction,
  createOnboardingFieldAction,
  restoreOnboardingFieldAction,
  updateOnboardingFieldAction,
} from "@/services/onboarding/admin-actions";
import { MEMBER_BUILTIN_FIELDS } from "@/services/member/builtin-fields";
import type { FieldData, FieldOption } from "@/services/onboarding/schema";
import {
  NUMERIC_ONLY_OPERATORS,
  VISIBLE_IF_OPERATORS,
  type VisibleIf,
  type VisibleIfOperator,
} from "@/services/onboarding/visibility";

type FieldType = FieldData["type"];

const FIELD_TYPES: FieldType[] = [
  "TEXT",
  "TEXTAREA",
  "EMAIL",
  "PHONE",
  "NUMBER",
  "SELECT",
  "MULTISELECT",
  "CHECKBOX",
  "DATE",
];

const TYPES_NEEDING_OPTIONS: FieldType[] = ["SELECT", "MULTISELECT"];

export type FieldRow = {
  id: string;
  key: string;
  type: FieldType;
  label: string;
  helpText: string | null;
  required: boolean;
  position: number;
  stepId: string | null;
  // Set when this field collects a typed Member column rather than a custom
  // applicationData answer. Immutable once created.
  builtinKey: string | null;
  options: FieldOption[];
  // Show (and require) this field only when another field's answer
  // satisfies a comparison. See services/onboarding/visibility.ts.
  visibleIf: VisibleIf | null;
  archivedAt: Date | null;
};

// Only active steps are offered — assigning a field to an archived step would
// silently drop it onto the first page anyway.
export type StepOption = { id: string; title: string };

export function OnboardingFields({
  target,
  fields,
  steps,
}: {
  target: "MEMBER" | "MERCHANT";
  fields: FieldRow[];
  steps: StepOption[];
}) {
  const t = useTranslations("fund.settings.onboarding.fields");
  const stepTitle = (id: string | null) =>
    steps.find((s) => s.id === id)?.title ?? null;

  // An attribute already on the form can't be added twice — including via an
  // archived field, which still occupies the (fund, target, key) slot.
  const usedBuiltinKeys = fields
    .map((f) => f.builtinKey)
    .filter((k): k is string => Boolean(k));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">
            {t(target === "MEMBER" ? "memberTitle" : "merchantTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              target === "MEMBER"
                ? "memberDescription"
                : "merchantDescription",
            )}
          </p>
        </div>
        <FieldDialog
          target={target}
          existingKeys={fields.map((f) => f.key)}
          usedBuiltinKeys={usedBuiltinKeys}
          steps={steps}
          dependencyChoices={fields.filter(
            (x) => !x.archivedAt && !x.builtinKey,
          )}
          trigger={
            <Button variant="default" size="sm">
              {t("add")}
            </Button>
          }
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.position")}</TableHead>
            <TableHead>{t("columns.label")}</TableHead>
            <TableHead>{t("columns.key")}</TableHead>
            <TableHead>{t("columns.type")}</TableHead>
            <TableHead>{t("columns.required")}</TableHead>
            {steps.length > 0 && <TableHead>{t("columns.step")}</TableHead>}
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {fields.length === 0 ? (
            <TableEmpty colSpan={steps.length > 0 ? 7 : 6}>
              {t("empty")}
            </TableEmpty>
          ) : (
            fields.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {f.position}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{f.label}</span>
                    {f.builtinKey && (
                      <Badge variant="info">{t("builtinBadge")}</Badge>
                    )}
                    {f.archivedAt && (
                      <Badge variant="default">{t("archived")}</Badge>
                    )}
                  </div>
                  {f.helpText && (
                    <div className="text-xs text-muted-foreground">
                      {f.helpText}
                    </div>
                  )}
                  {f.visibleIf && (
                    <div className="text-xs text-muted-foreground">
                      {t("visibleIfCaption", {
                        label:
                          fields.find((x) => x.key === f.visibleIf!.fieldKey)
                            ?.label ?? f.visibleIf.fieldKey,
                        operator: t(
                          `dialog.visibleIf.operators.${f.visibleIf.operator}` as never,
                        ),
                        value: f.visibleIf.value,
                      })}
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{f.key}</TableCell>
                <TableCell className="text-sm">{f.type}</TableCell>
                <TableCell>
                  {f.required ? (
                    <Badge variant="warning">{t("required")}</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                {steps.length > 0 && (
                  <TableCell className="text-sm text-muted-foreground">
                    {stepTitle(f.stepId) ?? t("firstStep")}
                  </TableCell>
                )}
                <TableCell className="text-right">
                  <div className="inline-flex items-center gap-1">
                    <FieldDialog
                      target={target}
                      existingKeys={fields
                        .filter((x) => x.id !== f.id)
                        .map((x) => x.key)}
                      usedBuiltinKeys={usedBuiltinKeys}
                      steps={steps}
                      dependencyChoices={fields.filter(
                        (x) => !x.archivedAt && !x.builtinKey && x.id !== f.id,
                      )}
                      edit={f}
                      trigger={
                        <Button variant="ghost" size="sm">
                          {t("edit")}
                        </Button>
                      }
                    />
                    <ArchiveButton field={f} />
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function FieldDialog({
  target,
  existingKeys,
  usedBuiltinKeys,
  steps,
  dependencyChoices,
  edit,
  trigger,
}: {
  target: "MEMBER" | "MERCHANT";
  existingKeys: string[];
  usedBuiltinKeys: string[];
  steps: StepOption[];
  // Other active, non-builtin fields this field's visibility can depend on —
  // excludes itself (when editing) and builtins (see visibility.ts).
  dependencyChoices: FieldRow[];
  edit?: FieldRow;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("fund.settings.onboarding.fields.dialog");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(edit?.key ?? "");
  const [type, setType] = useState<FieldType>(edit?.type ?? "TEXT");
  // "" = a custom question stored in applicationData; otherwise the Member
  // column this field fills. Only offered for the member form, and only when
  // creating: promoting a custom field would strand its historical answers.
  const [builtinKey, setBuiltinKey] = useState(edit?.builtinKey ?? "");
  const [label, setLabel] = useState(edit?.label ?? "");
  const [helpText, setHelpText] = useState(edit?.helpText ?? "");
  const [required, setRequired] = useState(edit?.required ?? false);
  const [position, setPosition] = useState(edit?.position ?? 0);
  const [stepId, setStepId] = useState<string>(edit?.stepId ?? "");
  const [optionsText, setOptionsText] = useState(
    edit?.options.map((o) => `${o.value}:${o.label}`).join("\n") ?? "",
  );
  // "" = always shown. Otherwise this field only appears once `dependsOnKey`'s
  // answer satisfies `operator`/`conditionValue` — see visibility.ts.
  const [dependsOnKey, setDependsOnKey] = useState(
    edit?.visibleIf?.fieldKey ?? "",
  );
  const [operator, setOperator] = useState<VisibleIfOperator>(
    edit?.visibleIf?.operator ?? "eq",
  );
  const [conditionValue, setConditionValue] = useState(
    edit?.visibleIf?.value ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isBuiltin = builtinKey !== "";
  const needsOptions = !isBuiltin && TYPES_NEEDING_OPTIONS.includes(type);
  // Built-ins are member-only, and the picker hides attributes already on the
  // form. When editing one, keep its own entry listed so the select can show it.
  const builtinChoices =
    target === "MEMBER"
      ? MEMBER_BUILTIN_FIELDS.filter(
          (b) => !usedBuiltinKeys.includes(b.key) || b.key === edit?.builtinKey,
        )
      : [];

  // Ordering comparisons (greater/less than) only make sense against a
  // NUMBER field; a text/select/checkbox dependency only offers equals/not.
  const dependency = dependencyChoices.find((d) => d.key === dependsOnKey);
  const operatorChoices =
    dependency?.type === "NUMBER"
      ? VISIBLE_IF_OPERATORS
      : VISIBLE_IF_OPERATORS.filter(
          (op) => !NUMERIC_ONLY_OPERATORS.includes(op),
        );

  const onPickDependency = (nextKey: string) => {
    setDependsOnKey(nextKey);
    const dep = dependencyChoices.find((d) => d.key === nextKey);
    if (dep?.type !== "NUMBER" && NUMERIC_ONLY_OPERATORS.includes(operator)) {
      setOperator("eq");
    }
  };

  const reset = () => {
    if (edit) return;
    setKey("");
    setType("TEXT");
    setBuiltinKey("");
    setLabel("");
    setHelpText("");
    setRequired(false);
    setPosition(0);
    setStepId("");
    setOptionsText("");
    setDependsOnKey("");
    setOperator("eq");
    setConditionValue("");
    setError(null);
  };

  // Picking an attribute fills in its standard label — the admin just told us
  // what this is, so making them retype "Postcode" is busywork. Still editable.
  const onPickBuiltin = (next: string) => {
    setBuiltinKey(next);
    const choice = MEMBER_BUILTIN_FIELDS.find((b) => b.key === next);
    setLabel(choice ? tRoot(choice.labelKey as never) : "");
  };

  const onSubmit = () => {
    setError(null);
    if (!edit && !isBuiltin && existingKeys.includes(key.trim())) {
      setError(tRoot("onboardingFields.errors.keyTaken" as never));
      return;
    }
    startTransition(async () => {
      const data: FieldData = {
        // For a built-in the server overrides both of these from its registry;
        // sending the attribute name keeps the payload honest either way.
        key: isBuiltin ? builtinKey : key.trim(),
        builtinKey: isBuiltin ? builtinKey : null,
        type,
        label: label.trim(),
        helpText: helpText.trim() || null,
        required,
        position,
        stepId: stepId || null,
        options: needsOptions ? parseOptions(optionsText) : undefined,
        visibleIf:
          !isBuiltin && dependsOnKey
            ? {
                fieldKey: dependsOnKey,
                operator,
                value: conditionValue.trim(),
              }
            : null,
      };
      const result = edit
        ? await updateOnboardingFieldAction({ fieldId: edit.id, data })
        : await createOnboardingFieldAction({ target, data });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      reset();
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
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{edit ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* Built-in-ness is fixed at creation: a custom field's answers
              already live in applicationData, so flipping it later would
              strand them, and repointing a built-in would rewrite meaning. */}
          {!edit && builtinChoices.length > 0 && (
            <div className="space-y-1">
              <Label htmlFor="field-builtin">{t("builtin")}</Label>
              <select
                id="field-builtin"
                value={builtinKey}
                onChange={(e) => onPickBuiltin(e.target.value)}
                className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">{t("builtinCustom")}</option>
                {builtinChoices.map((b) => (
                  <option key={b.key} value={b.key}>
                    {tRoot(b.labelKey as never)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t("builtinHint")}</p>
            </div>
          )}

          {isBuiltin ? (
            <div className="rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
              {t("builtinLocked", { key: builtinKey })}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="field-key">
                  {t("key")}
                  <span className="ml-1 text-destructive" aria-hidden>
                    *
                  </span>
                </Label>
                <Input
                  id="field-key"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="profession"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={Boolean(edit)}
                />
                <p className="text-xs text-muted-foreground">{t("keyHint")}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="field-type">{t("type")}</Label>
                <select
                  id="field-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as FieldType)}
                  className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {FIELD_TYPES.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="field-label">
              {t("label")}
              <span className="ml-1 text-destructive" aria-hidden>
                *
              </span>
            </Label>
            <Input
              id="field-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="field-help">{t("helpText")}</Label>
            <Input
              id="field-help"
              value={helpText}
              onChange={(e) => setHelpText(e.target.value)}
              autoComplete="off"
            />
          </div>
          {needsOptions && (
            <div className="space-y-1">
              <Label htmlFor="field-options">
                {t("options")}
                <span className="ml-1 text-destructive" aria-hidden>
                  *
                </span>
              </Label>
              <textarea
                id="field-options"
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                rows={4}
                placeholder={"value1:Label 1\nvalue2:Label 2"}
                className="w-full rounded-md bg-background px-2.5 py-1.5 font-mono text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                {t("optionsHint")}
              </p>
            </div>
          )}
          {steps.length > 0 && (
            <div className="space-y-1">
              <Label htmlFor="field-step">{t("step")}</Label>
              <select
                id="field-step"
                value={stepId}
                onChange={(e) => setStepId(e.target.value)}
                className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">{t("firstStep")}</option>
                {steps.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t("stepHint")}</p>
            </div>
          )}
          {!isBuiltin && dependencyChoices.length > 0 && (
            <div className="space-y-1">
              <Label htmlFor="field-visible-if">{t("visibleIf.label")}</Label>
              <select
                id="field-visible-if"
                value={dependsOnKey}
                onChange={(e) => onPickDependency(e.target.value)}
                className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">{t("visibleIf.none")}</option>
                {dependencyChoices.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
              {dependsOnKey && (
                <div className="grid grid-cols-2 gap-3 pt-1.5">
                  <select
                    aria-label={t("visibleIf.operatorLabel")}
                    value={operator}
                    onChange={(e) =>
                      setOperator(e.target.value as VisibleIfOperator)
                    }
                    className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {operatorChoices.map((op) => (
                      <option key={op} value={op}>
                        {t(`visibleIf.operators.${op}`)}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label={t("visibleIf.valueLabel")}
                    value={conditionValue}
                    onChange={(e) => setConditionValue(e.target.value)}
                    placeholder={t("visibleIf.valuePlaceholder")}
                    autoComplete="off"
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t("visibleIf.hint")}
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="field-position">{t("position")}</Label>
              <Input
                id="field-position"
                value={String(position)}
                onChange={(e) =>
                  setPosition(Number.parseInt(e.target.value) || 0)
                }
                inputMode="numeric"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 self-end pb-1.5 text-sm">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
                className="size-4 rounded border-input"
              />
              {t("required")}
            </label>
          </div>
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

function ArchiveButton({ field }: { field: FieldRow }) {
  const t = useTranslations("fund.settings.onboarding.fields.archive");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isArchived = field.archivedAt !== null;

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = isArchived
        ? await restoreOnboardingFieldAction({ fieldId: field.id })
        : await archiveOnboardingFieldAction({ fieldId: field.id });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            {isArchived ? t("restore") : t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isArchived ? t("restoreTitle") : t("title")}
          </DialogTitle>
          <DialogDescription>
            {isArchived ? t("restoreDescription") : t("description")}
          </DialogDescription>
        </DialogHeader>
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
          <Button
            variant={isArchived ? "default" : "destructive"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending
              ? t("saving")
              : isArchived
                ? t("restoreConfirm")
                : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// "value:label" per line, or "label" (in which case value = label).
function parseOptions(text: string): FieldOption[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.map((line) => {
    const [rawValue, ...labelParts] = line.split(":");
    const value = rawValue.trim();
    const label =
      labelParts.length > 0 ? labelParts.join(":").trim() : value;
    return { value, label };
  });
}
