// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Documentation the fund hands to whoever builds their website: the signup
// URL, and every query param it accepts to pre-fill the form. Without this the
// prefill contract is invisible — the param names are the fund's own field
// keys, which only exist in this settings page.

export type PrefillParam = {
  name: string;
  label: string;
  // Human-readable hint about accepted values, e.g. the option list.
  format: string | null;
};

export function SignupLinkReference({
  joinUrl,
  params,
}: {
  joinUrl: string;
  params: PrefillParam[];
}) {
  const t = useTranslations("fund.settings.onboarding.integration");

  // A worked example beats a spec: show the real URL with the first couple of
  // params actually filled in.
  const example = buildExample(joinUrl, params);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="text-sm font-medium">{t("urlLabel")}</div>
        <CopyableCode value={joinUrl} />
      </div>

      <div className="space-y-1.5">
        <div className="text-sm font-medium">{t("exampleLabel")}</div>
        <CopyableCode value={example} />
        <p className="text-xs text-muted-foreground">{t("exampleHint")}</p>
      </div>

      <div className="space-y-1.5">
        <div className="text-sm font-medium">{t("paramsLabel")}</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.param")}</TableHead>
              <TableHead>{t("columns.field")}</TableHead>
              <TableHead>{t("columns.format")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {params.map((p) => (
              <TableRow key={p.name}>
                <TableCell className="font-mono text-xs">{p.name}</TableCell>
                <TableCell className="text-sm">{p.label}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {p.format ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">{t("paramsHint")}</p>
      </div>
    </div>
  );
}

function CopyableCode({ value }: { value: string }) {
  const t = useTranslations("fund.settings.onboarding.integration");
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied (insecure context, permissions). The
      // value is on screen and selectable, so there's nothing to recover.
    }
  };

  return (
    <div className="flex items-start gap-2">
      <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all">
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onCopy}
        aria-label={t("copy")}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </div>
  );
}

const EXAMPLE_VALUES: Record<string, string> = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.org",
};

function buildExample(joinUrl: string, params: PrefillParam[]): string {
  const url = new URL(joinUrl);
  // Identity first (every fund has it), then the fund's own first extra so
  // the example shows both halves of the contract.
  const shown = params
    .filter((p) => p.name in EXAMPLE_VALUES)
    .slice(0, 3)
    .map((p) => [p.name, EXAMPLE_VALUES[p.name]] as const);

  const extra = params.find((p) => !(p.name in EXAMPLE_VALUES));
  for (const [name, value] of shown) url.searchParams.set(name, value);
  if (extra) url.searchParams.set(extra.name, "…");

  // Decoded for readability — this is documentation, not a value to fetch.
  return decodeURIComponent(url.toString());
}
