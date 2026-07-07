// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";

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
import type { MemberStatus } from "@/services/db/generated/enums";
import { SUPPORTED_LOCALES } from "@/services/i18n/config";
import { importMembersAction } from "@/services/member/import-actions";
import {
  MEMBER_IMPORT_FIELDS,
  recognizeStatus,
  type MemberImportField,
  type MemberImportResult,
  type StatusValueMap,
} from "@/services/member/import-config";
import { MEMBER_STATUSES } from "@/services/member/status-config";

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
  contributionAmount: /contribut|cotisation|montant|engage|commit|pledge|bijdrage|aporta/i,
  locale: /lang|langue|taal|idioma|locale/i,
  status: /status|statut|[ée]tat|toestand|estado/i,
  notes: /note|remarq|opmerking|nota/i,
  // serial claims explicit serial-ish headers first (field order); any other
  // card-ish header ("Carte", "N° carte", "card number") falls to cardNumber.
  // Both only link existing cards — import never creates any.
  serial: /serial|uid|nfc|puce/i,
  cardNumber: /carte|card|kaart/i,
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
  showContribution,
}: {
  triggerLabel: string;
  tiers: string[];
  // Only FIXED_PERIOD funds with tiers can import a commitment amount.
  showContribution: boolean;
}) {
  const t = useTranslations("members.admin.import");
  const tStatus = useTranslations("members.admin.status.values");
  const tLocale = useTranslations("locale");
  // Supported languages for the manual "fixed value" language picker.
  const languages = SUPPORTED_LOCALES.map((loc) => ({
    value: loc,
    label: tLocale(loc),
  }));
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  // Fixed values for fields left unmapped (applied to every row).
  const [defaults, setDefaults] = useState<Mapping>(EMPTY_MAPPING);
  // Admin overrides for raw status values (the interactive mapping step).
  const [statusMap, setStatusMap] = useState<StatusValueMap>({});
  // Backfill mode: match existing members by email and update only the mapped
  // columns (never create). Relaxes the required-mapping to just email.
  const [updateOnly, setUpdateOnly] = useState(false);
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

  // Update-only backfill only needs the email match key; a full import needs
  // the name columns too. Drives both the submit gate and the field asterisks.
  const requiredKeys: MemberImportField[] = updateOnly
    ? ["email"]
    : MEMBER_IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key);
  const requiredOk = requiredKeys.every((key) => mapping[key] !== "");

  // Distinct raw values in the mapped status column — drives the interactive
  // mapping step below. Empty when no status column is mapped.
  const statusColumnValues = useMemo(() => {
    const col = mapping.status;
    if (!col || !csv.trim()) return [] as string[];
    const { headers: h, rows } = parseCsv(csv);
    const idx = h.indexOf(col);
    if (idx === -1) return [] as string[];
    const seen = new Set<string>();
    const values: string[] = [];
    for (const row of rows) {
      const v = (row[idx] ?? "").trim();
      if (v && !seen.has(v.toLowerCase())) {
        seen.add(v.toLowerCase());
        values.push(v);
      }
    }
    return values;
  }, [csv, mapping.status]);

  // Resolve a raw status value: admin override → auto-recognized → NEW.
  const effectiveStatus = (raw: string): MemberStatus =>
    statusMap[raw] ?? recognizeStatus(raw) ?? "NEW";

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
    // Resolved status for every distinct value in the mapped status column.
    const statusValueMap: StatusValueMap = {};
    for (const v of statusColumnValues) statusValueMap[v] = effectiveStatus(v);
    startTransition(async () => {
      const res = await importMembersAction({
        csv,
        mapping: cleaned,
        defaults: cleanedDefaults,
        statusValueMap,
        updateOnly,
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
          setStatusMap({});
          setUpdateOnly(false);
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
              <Label htmlFor="import-mode">{t("mode.label")}</Label>
              <select
                id="import-mode"
                value={updateOnly ? "update" : "upsert"}
                onChange={(e) => setUpdateOnly(e.target.value === "update")}
                className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="upsert">{t("mode.upsert")}</option>
                <option value="update">{t("mode.updateOnly")}</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {updateOnly ? t("mode.updateOnlyHint") : t("mode.upsertHint")}
              </p>
            </div>
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
                  {MEMBER_IMPORT_FIELDS.filter(
                    (f) => showContribution || f.key !== "contributionAmount",
                  ).map((f) => (
                    <div key={f.key} className="space-y-1">
                      <Label htmlFor={`map-${f.key}`} className="text-xs">
                        {t(`fields.${f.key}`)}
                        {requiredKeys.includes(f.key) && (
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
                          languages={languages}
                          statuses={MEMBER_STATUSES.map((s) => ({
                            value: s,
                            label: tStatus(s),
                          }))}
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

            {statusColumnValues.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("statusMapHeading")}
                </p>
                <div className="space-y-1.5">
                  {statusColumnValues.map((raw) => {
                    const unresolved = !recognizeStatus(raw) && !statusMap[raw];
                    return (
                      <div key={raw} className="flex items-center gap-2">
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-xs"
                          title={raw}
                        >
                          {raw}
                        </span>
                        {unresolved && (
                          <span className="shrink-0 text-xs text-warning">
                            {t("statusUnrecognized")}
                          </span>
                        )}
                        <select
                          aria-label={raw}
                          value={effectiveStatus(raw)}
                          onChange={(e) =>
                            setStatusMap((m) => ({
                              ...m,
                              [raw]: e.target.value as MemberStatus,
                            }))
                          }
                          className="h-7 w-32 shrink-0 rounded-md bg-background px-2 text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {MEMBER_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {tStatus(s)}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
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
// Tier and language are dropdowns (fund tier names / supported languages);
// household counts are numeric; everything else is free text. The value is
// sent in `defaults`.
function FixedValueInput({
  field,
  tiers,
  languages,
  statuses,
  value,
  onChange,
  placeholder,
  tierNone,
}: {
  field: MemberImportField;
  tiers: string[];
  languages: { value: string; label: string }[];
  statuses: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  tierNone: string;
}) {
  const cls =
    "h-7 w-full rounded-md bg-background px-2 text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring";

  // A fixed default makes no sense for card identifiers — it would link the
  // same card to every imported row. The server ignores them too.
  if (field === "serial" || field === "cardNumber") return null;

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

  if (field === "locale") {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cls}
      >
        <option value="">{tierNone}</option>
        {languages.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
    );
  }

  if (field === "status") {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cls}
      >
        <option value="">{tierNone}</option>
        {statuses.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    );
  }

  const numeric =
    field === "householdAdults" || field === "householdChildren";
  const money = field === "contributionAmount";
  return (
    <Input
      type={numeric || money ? "number" : "text"}
      min={numeric || money ? 0 : undefined}
      step={money ? "0.01" : undefined}
      inputMode={money ? "decimal" : numeric ? "numeric" : undefined}
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
      {result.cardNumbersNotFound.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            <div>
              {t("cardNumbersNotFound", {
                count: result.cardNumbersNotFound.length,
              })}
            </div>
            <div className="mt-1 font-mono text-xs">
              {result.cardNumbersNotFound.join(", ")}
            </div>
          </AlertDescription>
        </Alert>
      )}
      {result.statusesDefaulted.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            <div>
              {t("statusesDefaulted", {
                count: result.statusesDefaulted.length,
              })}
            </div>
            <div className="mt-1 font-mono text-xs">
              {result.statusesDefaulted.join(", ")}
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
