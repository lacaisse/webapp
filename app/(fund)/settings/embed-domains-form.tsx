// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateEmbedDomainsAction } from "@/services/embed/admin-actions";
import { EmbedDomainsSchema, MAX_EMBED_DOMAINS } from "@/services/embed/schema";

// The allowlist editor. A textarea rather than the declarative SettingsForm:
// that helper maps one input to one scalar column, and this is a list.
//
// Hand-rolled useTransition + inline Alert for the same reason. Validation runs
// against the same Zod schema the server action re-checks, so a typo is caught
// before the round-trip — and caught again server-side, since a client check is
// a convenience and never a control.

export function EmbedDomainsForm({
  initialDomains,
}: {
  initialDomains: string[];
}) {
  const t = useTranslations("fund.settings.embeds.domains");
  // Root translator: schema messages are i18n keys, resolved dynamically.
  const tRoot = useTranslations();

  const [value, setValue] = useState(initialDomains.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // Reflects what's in the box, not what's saved — the warning should appear as
  // soon as someone clears the field, not only after they save.
  const isEmpty = value.trim().length === 0;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const parsed = EmbedDomainsSchema.safeParse({ domains: value });
    if (!parsed.success) {
      setError(tRoot(parsed.error.issues[0].message as never));
      return;
    }

    startTransition(async () => {
      const result = await updateEmbedDomainsAction({ domains: value });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="embed-domains">{t("label")}</Label>
        <textarea
          id="embed-domains"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          rows={5}
          spellCheck={false}
          placeholder={"example.org\n*.example.org\nlocalhost:3000"}
          className="w-full rounded-md bg-background px-2.5 py-1.5 font-mono text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          {t("help", { max: MAX_EMBED_DOMAINS })}
        </p>
      </div>

      {isEmpty ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertDescription>{t("emptyWarning")}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {saved ? (
        <Alert>
          <Check className="size-4" />
          <AlertDescription>{t("saved")}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? t("saving") : t("save")}
      </Button>
    </form>
  );
}
