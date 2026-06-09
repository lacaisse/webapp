// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseCsv } from "@/services/csv/parse";
import { importMembersAction } from "@/services/member/import-actions";
import {
  MEMBER_IMPORT_FIELDS,
  type MemberImportField,
  type MemberImportResult,
} from "@/services/member/import-config";

// Header synonyms (EN/FR/NL/ES) for auto-guessing the column mapping.
const FIELD_PATTERNS: Record<MemberImportField, RegExp> = {
  firstName: /first|pr[ée]nom|voornaam|nombre/i,
  lastName: /last|surname|^nom|achternaam|apellido/i,
  email: /e-?mail|courriel|correo/i,
  phone: /phone|tel|gsm|t[ée]l|tel[ée]fono/i,
  iban: /iban|compte|account|rekening/i,
  address: /address|adresse|adres|direcci|rue|straat/i,
  postalCode: /postal|zip|\bcp\b|postcode|code\s*post/i,
  city: /city|ville|stad|ciudad|gemeente|localit/i,
  householdAdults: /adult|adulte|volwassen/i,
  householdChildren: /child|enfant|kind|ni[ñn]o/i,
  tier: /tier|palier|classe|class|niveau|schijf|nivel/i,
  notes: /note|remarq|opmerking|nota/i,
  serial: /serial|carte|card|uid|nfc/i,
};

type Mapping = Record<MemberImportField, string>;
const EMPTY_MAPPING = Object.fromEntries(
  MEMBER_IMPORT_FIELDS.map((f) => [f.key, ""]),
) as Mapping;

function guessMapping(headers: string[]): Mapping {
  const mapping = { ...EMPTY_MAPPING };
  const used = new Set<string>();
  for (const f of MEMBER_IMPORT_FIELDS) {
    const hit = headers.find(
      (h) => !used.has(h) && FIELD_PATTERNS[f.key].test(h),
    );
    if (hit) {
      mapping[f.key] = hit;
      used.add(hit);
    }
  }
  return mapping;
}

export function MemberImportDialog({
  triggerLabel,
  tiers,
}: {
  triggerLabel: string;
  tiers: string[];
}) {
  const t = useTranslations("members.admin.import");
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  // Fixed values for fields left unmapped (applied to every row).
  const [defaults, setDefaults] = useState<Mapping>(EMPTY_MAPPING);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    Extract<MemberImportResult, { ok: true }> | null
  >(null);
  const [pending, startTransition] = useTransition();

  const applyCsv = (text: string) => {
    setCsv(text);
    setError(null);
    setResult(null);
    const h = text.trim() ? parseCsv(text).headers : [];
    setHeaders(h);
    setMapping(h.length ? guessMapping(h) : EMPTY_MAPPING);
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    file.text().then(applyCsv);
  };

  const requiredOk = MEMBER_IMPORT_FIELDS.filter((f) => f.required).every(
    (f) => mapping[f.key] !== "",
  );

  const submit = () => {
    setError(null);
    setResult(null);
    const cleaned = Object.fromEntries(
      Object.entries(mapping).filter(([, v]) => v !== ""),
    );
    // Fixed values only for fields not mapped to a column (the column wins).
    const cleanedDefaults = Object.fromEntries(
      Object.entries(defaults).filter(([k, v]) => v !== "" && !cleaned[k]),
    );
    startTransition(async () => {
      const res = await importMembersAction({
        csv,
        mapping: cleaned,
        defaults: cleanedDefaults,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setResult(res);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setCsv("");
          setHeaders([]);
          setDefaults(EMPTY_MAPPING);
          setError(null);
          setResult(null);
        }
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {result ? (
          <ResultView result={result} t={t} />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="member-csv-file">{t("fileLabel")}</Label>
              <input
                id="member-csv-file"
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(e) => onFile(e.target.files?.[0])}
                className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="member-csv">{t("pasteLabel")}</Label>
              <textarea
                id="member-csv"
                value={csv}
                onChange={(e) => applyCsv(e.target.value)}
                rows={4}
                className="w-full rounded-md bg-background px-2 py-1.5 font-mono text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {headers.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("mapHeading")}
                </p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {MEMBER_IMPORT_FIELDS.map((f) => (
                    <div key={f.key} className="space-y-1">
                      <Label htmlFor={`map-${f.key}`} className="text-xs">
                        {t(`fields.${f.key}`)}
                        {f.required && (
                          <span className="ml-0.5 text-destructive">*</span>
                        )}
                      </Label>
                      <select
                        id={`map-${f.key}`}
                        value={mapping[f.key]}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [f.key]: e.target.value }))
                        }
                        className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <option value="">{t("none")}</option>
                        {headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                      {mapping[f.key] === "" && !f.required && (
                        <FixedValueInput
                          field={f.key}
                          tiers={tiers}
                          value={defaults[f.key]}
                          onChange={(v) =>
                            setDefaults((d) => ({ ...d, [f.key]: v }))
                          }
                          placeholder={t("fixedValuePlaceholder")}
                          tierNone={t("none")}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {result ? t("close") : t("cancel")}
          </Button>
          {!result && (
            <Button
              onClick={submit}
              disabled={pending || headers.length === 0 || !requiredOk}
            >
              {pending ? t("importing") : t("import")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Fixed-value control shown when a non-required field has no column mapped.
// Tier is a dropdown of the fund's tier names; household counts are numeric;
// everything else is free text. The value is sent in `defaults`.
function FixedValueInput({
  field,
  tiers,
  value,
  onChange,
  placeholder,
  tierNone,
}: {
  field: MemberImportField;
  tiers: string[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  tierNone: string;
}) {
  const cls =
    "h-7 w-full rounded-md bg-background px-2 text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring";

  if (field === "tier") {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cls}
      >
        <option value="">{tierNone}</option>
        {tiers.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    );
  }

  const numeric =
    field === "householdAdults" || field === "householdChildren";
  return (
    <Input
      type={numeric ? "number" : "text"}
      min={numeric ? 0 : undefined}
      inputMode={numeric ? "numeric" : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-7 text-xs"
      autoComplete="off"
    />
  );
}

function ResultView({
  result,
  t,
}: {
  result: Extract<MemberImportResult, { ok: true }>;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="space-y-3">
      <Alert variant="default">
        <AlertDescription>
          {t("result", {
            created: result.created,
            updated: result.updated,
            cardsLinked: result.cardsLinked,
          })}
        </AlertDescription>
      </Alert>
      {result.serialsNotFound.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            <div>
              {t("serialsNotFound", { count: result.serialsNotFound.length })}
            </div>
            <div className="mt-1 font-mono text-xs">
              {result.serialsNotFound.join(", ")}
            </div>
          </AlertDescription>
        </Alert>
      )}
      {result.skipped.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            <div>{t("skippedTitle", { count: result.skipped.length })}</div>
            <ul className="mt-1 space-y-0.5 text-xs">
              {result.skipped.slice(0, 20).map((s) => (
                <li key={s.row}>
                  {t("rowLabel", { row: s.row })}: {s.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
