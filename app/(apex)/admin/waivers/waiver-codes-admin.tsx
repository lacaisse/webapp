// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

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
  CreateWaiverCodeSchema,
  WAIVER_EXPIRES_DAYS_MAX,
  WAIVER_LABEL_MAX,
  WAIVER_LABEL_MIN,
  WAIVER_MAX_USES_MAX,
  type CreateWaiverCodeInput,
  type CreateWaiverCodeValues,
} from "@/services/fund-setup/schema";
import {
  createWaiverCodeAction,
  revokeWaiverCodeAction,
} from "@/services/fund-setup/waiver-admin-actions";

// The shared schema's messages are translation keys with these placeholders.
const SCHEMA_PARAMS = {
  min: WAIVER_LABEL_MIN,
  max: WAIVER_LABEL_MAX,
  maxUses: WAIVER_MAX_USES_MAX,
  maxDays: WAIVER_EXPIRES_DAYS_MAX,
};

// The number fields are typed as text: a blank or non-integer value becomes
// NaN (or null for the optional expiry), which the shared schema refuses with
// its range message — one rule, validated in the browser and on the server.
function toInt(raw: unknown): number {
  const text = String(raw ?? "").trim();
  const n = Number(text);
  return text !== "" && Number.isInteger(n) ? n : Number.NaN;
}

// `joinUrl`: the apex /join door, named in the hand-over hint (built
// server-side — the page knows the apex, the browser bundle must not).
export function CreateWaiverCodeForm({ joinUrl }: { joinUrl: string }) {
  const t = useTranslations("admin.waivers.create");
  const tRoot = useTranslations();
  const router = useRouter();
  const [created, setCreated] = useState<{ code: string; label: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const form = useForm<CreateWaiverCodeInput, unknown, CreateWaiverCodeValues>({
    resolver: zodResolver(CreateWaiverCodeSchema),
    defaultValues: { label: "", maxUses: 1, expiresInDays: null },
  });

  const onSubmit = (values: CreateWaiverCodeValues) =>
    startTransition(async () => {
      const result = await createWaiverCodeAction(values);
      if ("error" in result) {
        form.setError("root", { message: result.error });
        return;
      }
      setCreated({ code: result.code, label: values.label });
      form.reset();
      router.refresh();
    });

  const errors = form.formState.errors;
  const translateError = (message: string | undefined) => {
    if (!message) return null;
    return message.startsWith("admin.")
      ? tRoot(message as never, SCHEMA_PARAMS as never)
      : message;
  };
  const fieldError = (message: string | undefined) =>
    message ? <p className="text-xs text-destructive">{translateError(message)}</p> : null;

  return (
    <div className="space-y-4">
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid gap-4 sm:grid-cols-[1fr_8rem_10rem_auto] sm:items-start"
      >
        <div className="space-y-1.5">
          <Label htmlFor="waiver-label">{t("label")}</Label>
          <Input
            id="waiver-label"
            maxLength={WAIVER_LABEL_MAX}
            autoComplete="off"
            aria-invalid={errors.label ? true : undefined}
            disabled={pending}
            {...form.register("label")}
          />
          <p className="text-xs text-muted-foreground">{t("labelHint")}</p>
          {fieldError(errors.label?.message)}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="waiver-max-uses">{t("maxUses")}</Label>
          <Input
            id="waiver-max-uses"
            inputMode="numeric"
            aria-invalid={errors.maxUses ? true : undefined}
            disabled={pending}
            {...form.register("maxUses", { setValueAs: toInt })}
          />
          <p className="text-xs text-muted-foreground">
            {t("maxUsesHint", { max: WAIVER_MAX_USES_MAX })}
          </p>
          {fieldError(errors.maxUses?.message)}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="waiver-expires">{t("expiresInDays")}</Label>
          <Input
            id="waiver-expires"
            inputMode="numeric"
            placeholder="—"
            aria-invalid={errors.expiresInDays ? true : undefined}
            disabled={pending}
            {...form.register("expiresInDays", {
              setValueAs: (raw: unknown) =>
                String(raw ?? "").trim() === "" ? null : toInt(raw),
            })}
          />
          <p className="text-xs text-muted-foreground">
            {t("expiresInDaysHint", { max: WAIVER_EXPIRES_DAYS_MAX })}
          </p>
          {fieldError(errors.expiresInDays?.message)}
        </div>
        <Button type="submit" disabled={pending} className="sm:mt-6">
          {pending ? t("submitting") : t("submit")}
        </Button>
      </form>
      {errors.root?.message && (
        <p className="text-sm text-destructive">{translateError(errors.root.message)}</p>
      )}
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

// Revoking is irreversible for new redemptions, so it is confirmed in an
// in-app dialog (never window.confirm — AGENTS.md).
export function RevokeWaiverCodeButton({ id }: { id: string }) {
  const t = useTranslations("admin.waivers");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const revoke = () =>
    startTransition(async () => {
      setError(null);
      const result = await revokeWaiverCodeAction(id);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            {t("revoke")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("revokeTitle")}</DialogTitle>
          <DialogDescription>{t("revokeConfirm")}</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("revokeCancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={revoke} disabled={pending}>
            {pending ? t("revoking") : t("revoke")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
