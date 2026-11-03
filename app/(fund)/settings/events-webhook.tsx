// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, CheckCircle2, Loader2, Webhook } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { registerCitizenPayEventsWebhookAction } from "@/services/citizenpay/events-webhook-actions";

// Settings → Citizen Pay: the treasury events webhook (card.blocked /
// card.unblocked). Shows whether it is registered with the api, the last
// registration error, the last delivery received, and a button that
// registers it (again) — for funds connected before the webhook existed and
// after a failed attempt. The registration itself is
// services/citizenpay/events-webhook.ts.

export type EventsWebhookStatus = {
  connected: boolean;
  url: string;
  // ISO strings: Dates can't cross the server/client boundary.
  registeredAt: string | null;
  error: string | null;
  lastDelivery: {
    type: string;
    serial: string | null;
    receivedAt: string;
    outcome: "RECEIVED" | "APPLIED" | "IGNORED" | "FAILED";
    detail: string | null;
  } | null;
};

export function EventsWebhookSection({ status }: { status: EventsWebhookStatus }) {
  const t = useTranslations("fund.settings.citizenpay.events");
  const format = useFormatter();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const register = () => {
    setError(null);
    startTransition(async () => {
      const res = await registerCitizenPayEventsWebhookAction();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="space-y-3 border-t border-border pt-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Webhook className="size-4" />
          {t("title")}
        </div>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
        {status.registeredAt ? (
          <div className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="size-4 text-emerald-600" />
            <span>{t("registeredAt", { date: when(status.registeredAt) })}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 text-warning" />
            <span>{t("notRegistered")}</span>
          </div>
        )}
        <dl className="text-xs text-muted-foreground space-y-0.5">
          <div className="flex gap-2">
            <dt className="min-w-24">{t("urlLabel")}</dt>
            <dd className="font-mono break-all">{status.url}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="min-w-24">{t("lastDeliveryLabel")}</dt>
            <dd>
              {status.lastDelivery
                ? t("lastDelivery", {
                    type: status.lastDelivery.type,
                    serial: status.lastDelivery.serial ?? "—",
                    date: when(status.lastDelivery.receivedAt),
                    outcome: t(`outcome.${status.lastDelivery.outcome}`),
                  })
                : t("noDelivery")}
            </dd>
          </div>
          {status.lastDelivery?.detail && (
            <div className="flex gap-2">
              <dt className="min-w-24" />
              <dd>{status.lastDelivery.detail}</dd>
            </div>
          )}
        </dl>
        {status.error && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>
              {t("registrationError", { message: status.error })}
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={register}
            disabled={pending || !status.connected}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Webhook className="size-3.5" />
            )}
            {pending
              ? t("registering")
              : status.registeredAt
                ? t("reregister")
                : t("register")}
          </Button>
          {!status.connected && (
            <p className="mt-1 text-xs text-muted-foreground">{t("connectFirst")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
