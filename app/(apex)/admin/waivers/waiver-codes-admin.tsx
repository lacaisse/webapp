// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  WAIVER_EXPIRES_DAYS_MAX,
  WAIVER_LABEL_MAX,
  WAIVER_MAX_USES_MAX,
} from "@/services/fund-setup/schema";
import {
  createWaiverCodeAction,
  revokeWaiverCodeAction,
} from "@/services/fund-setup/waiver-admin-actions";

// Numbers travel as numbers: a blank or non-integer field becomes NaN, which
// the schema refuses with the range message — no client-side duplicate of
// the rule.
function toInt(raw: string): number {
  const n = Number(raw.trim());
  return raw.trim() !== "" && Number.isInteger(n) ? n : Number.NaN;
}

// `joinUrl`: the apex /join door, named in the hand-over hint (built
// server-side — the page knows the apex, the browser bundle must not).
export function CreateWaiverCodeForm({ joinUrl }: { joinUrl: string }) {
  const t = useTranslations("admin.waivers.create");
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; label: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createWaiverCodeAction({
        label,
        maxUses: toInt(maxUses),
        expiresInDays: expiresInDays.trim() === "" ? null : toInt(expiresInDays),
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setCreated({ code: result.code, label: label.trim() });
      setLabel("");
      setMaxUses("1");
      setExpiresInDays("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-[1fr_8rem_10rem_auto] sm:items-start">
        <div className="space-y-1.5">
          <Label htmlFor="waiver-label">{t("label")}</Label>
          <Input
            id="waiver-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={WAIVER_LABEL_MAX}
            autoComplete="off"
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">{t("labelHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="waiver-max-uses">{t("maxUses")}</Label>
          <Input
            id="waiver-max-uses"
            inputMode="numeric"
            value={maxUses}
            onChange={(event) => setMaxUses(event.target.value)}
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">{t("maxUsesHint", { max: WAIVER_MAX_USES_MAX })}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="waiver-expires">{t("expiresInDays")}</Label>
          <Input
            id="waiver-expires"
            inputMode="numeric"
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
            placeholder="—"
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">
            {t("expiresInDaysHint", { max: WAIVER_EXPIRES_DAYS_MAX })}
          </p>
        </div>
        <Button type="submit" disabled={pending || label.trim() === ""} className="sm:mt-6">
          {pending ? t("submitting") : t("submit")}
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {created && <CreatedCode code={created.code} label={created.label} joinUrl={joinUrl} />}
    </div>
  );
}

function CreatedCode({ code, label, joinUrl }: { code: string; label: string; joinUrl: string }) {
  const t = useTranslations("admin.waivers.create");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (insecure context, permissions): the code is on
      // screen to select by hand.
    }
  };

  return (
    <div className="rounded-lg border bg-success/10 p-4">
      <p className="text-sm font-medium">{t("createdTitle", { label })}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="font-mono text-2xl tracking-wider">{code}</code>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{t("createdHint", { joinUrl })}</p>
    </div>
  );
}

export function RevokeWaiverCodeButton({ id }: { id: string }) {
  const t = useTranslations("admin.waivers");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const revoke = () => {
    if (!window.confirm(t("revokeConfirm"))) return;
    setError(null);
    startTransition(async () => {
      const result = await revokeWaiverCodeAction(id);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" onClick={revoke} disabled={pending}>
        {pending ? t("revoking") : t("revoke")}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
