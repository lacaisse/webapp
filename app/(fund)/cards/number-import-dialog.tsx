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
import { Label } from "@/components/ui/label";
import { importCardNumbersAction } from "@/services/card/admin-actions";
import { parseCsv } from "@/services/csv/parse";

// Best-effort initial guess for which header is the serial / number column.
function guessColumn(headers: string[], patterns: RegExp): string {
  return headers.find((h) => patterns.test(h)) ?? "";
}

export function NumberImportDialog() {
  const t = useTranslations("fund.cards.numberImport");
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [serialColumn, setSerialColumn] = useState("");
  const [numberColumn, setNumberColumn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    applied: number;
    provisioned: number;
    displaced: number;
    skipped: string[];
  } | null>(null);
  const [pending, startTransition] = useTransition();

  // Parse headers + re-guess the column mapping whenever the CSV changes
  // (file pick or paste). Done in the handler, not an effect.
  const applyCsv = (text: string) => {
    setCsv(text);
    setError(null);
    setResult(null);
    const h = text.trim() ? parseCsv(text).headers : [];
    setHeaders(h);
    if (h.length === 0) {
      setSerialColumn("");
      setNumberColumn("");
      return;
    }
    setSerialColumn(guessColumn(h, /serial|uid|nfc/i) || h[0]);
    setNumberColumn(
      guessColumn(h, /number|num|n°|nr|no\b/i) || h[1] || h[0],
    );
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    file.text().then(applyCsv);
  };

  const submit = () => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await importCardNumbersAction({
        csv,
        serialColumn,
        numberColumn,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setResult(res);
    });
  };

  const canImport =
    headers.length > 0 &&
    serialColumn !== "" &&
    numberColumn !== "" &&
    serialColumn !== numberColumn;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setCsv("");
          setError(null);
          setResult(null);
        }
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="card-number-csv-file">{t("fileLabel")}</Label>
            <input
              id="card-number-csv-file"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => onFile(e.target.files?.[0])}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="card-number-csv">{t("pasteLabel")}</Label>
            <textarea
              id="card-number-csv"
              value={csv}
              onChange={(e) => applyCsv(e.target.value)}
              rows={6}
              placeholder={"serial,number\n04516F320A1291,17"}
              className="w-full rounded-md bg-background px-2 py-1.5 font-mono text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {headers.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <ColumnSelect
                id="serial-col"
                label={t("serialColumn")}
                headers={headers}
                value={serialColumn}
                onChange={setSerialColumn}
              />
              <ColumnSelect
                id="number-col"
                label={t("numberColumn")}
                headers={headers}
                value={numberColumn}
                onChange={setNumberColumn}
              />
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {result && (
            <Alert variant={result.skipped.length ? "warning" : "default"}>
              <AlertDescription>
                {t("result", {
                  applied: result.applied,
                  provisioned: result.provisioned,
                  displaced: result.displaced,
                })}
                {result.skipped.length > 0 && (
                  <div className="mt-1 font-mono text-xs">
                    {t("skipped", { count: result.skipped.length })}:{" "}
                    {result.skipped.join(", ")}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {result ? t("close") : t("cancel")}
          </Button>
          {!result && (
            <Button onClick={submit} disabled={pending || !canImport}>
              {pending ? t("importing") : t("import")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ColumnSelect({
  id,
  label,
  headers,
  value,
  onChange,
}: {
  id: string;
  label: string;
  headers: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );
}
