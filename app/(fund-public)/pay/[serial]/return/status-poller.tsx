// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  CheckCircle2,
  Clock,
  Loader2,
  SearchX,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import type { TopUpStatus } from "@/services/card-topup/verify";

import { pollCardTopUpAction } from "../actions";

type Status = TopUpStatus | "not_found";

// Poll every 3 s for about two minutes; after that the cron's sweep takes
// over and the member is told they can close the page.
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 40;

const FINAL: ReadonlySet<Status> = new Set([
  "minted",
  "expired",
  "cancelled",
  "not_found",
]);

export function TopUpStatusPoller({
  serial,
  topUpId,
  paymentRequestId,
  fundName,
  initialStatus,
  amountCents,
}: {
  serial: string;
  topUpId: string;
  paymentRequestId?: number;
  fundName: string;
  initialStatus: TopUpStatus;
  amountCents: number;
}) {
  const t = useTranslations("cotisation.topUp.return");
  const format = useFormatter();
  const [status, setStatus] = useState<Status>(initialStatus);
  const [checkFailed, setCheckFailed] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const attempts = useRef(0);

  useEffect(() => {
    if (FINAL.has(initialStatus)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      attempts.current += 1;
      try {
        const res = await pollCardTopUpAction({
          serial,
          topUpId,
          paymentRequestId,
        });
        if (cancelled) return;
        setStatus(res.status);
        setCheckFailed("checkFailed" in res && !!res.checkFailed);
        if (FINAL.has(res.status)) return;
      } catch {
        if (cancelled) return;
        setCheckFailed(true);
      }
      if (attempts.current >= POLL_MAX_ATTEMPTS) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [serial, topUpId, paymentRequestId, initialStatus]);

  const amount = format.number(amountCents / 100, {
    style: "currency",
    currency: "EUR",
  });

  const view = (() => {
    switch (status) {
      case "minted":
        return {
          icon: <CheckCircle2 className="size-10 text-emerald-600" />,
          title: t("mintedTitle"),
          body: t("mintedBody", { amount }),
        };
      case "signed":
        // Paid but not credited after the polling window: stop spinning and
        // say the credit is being verified (the cron sweep finishes it, or
        // an operator does) and who to contact.
        return gaveUp
          ? {
              icon: <Clock className="size-10 text-muted-foreground" />,
              title: t("verifyingTitle"),
              body: t("verifyingBody", { fundName }),
            }
          : {
              icon: <Loader2 className="size-10 animate-spin text-primary" />,
              title: t("signedTitle"),
              body: t("signedBody"),
            };
      case "expired":
        return {
          icon: <Clock className="size-10 text-muted-foreground" />,
          title: t("expiredTitle"),
          body: t("expiredBody"),
        };
      case "cancelled":
        return {
          icon: <XCircle className="size-10 text-muted-foreground" />,
          title: t("cancelledTitle"),
          body: t("cancelledBody"),
        };
      case "not_found":
        return {
          icon: <SearchX className="size-10 text-muted-foreground" />,
          title: t("mismatchTitle"),
          body: t("mismatchBody", { fundName }),
        };
      default:
        return {
          icon: gaveUp ? (
            <Clock className="size-10 text-muted-foreground" />
          ) : (
            <Loader2 className="size-10 animate-spin text-primary" />
          ),
          title: t("pendingTitle"),
          body: gaveUp ? t("pendingLong") : t("pendingBody"),
        };
    }
  })();

  const canRetry =
    status === "expired" || status === "cancelled" || status === "not_found";

  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center" aria-live="polite">
      {view.icon}
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{view.title}</h2>
        <p className="text-sm text-muted-foreground">{view.body}</p>
      </div>
      <dl className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
        <dt className="text-muted-foreground">{t("amount")}</dt>
        <dd className="font-medium">{amount}</dd>
      </dl>
      {checkFailed && !FINAL.has(status) && !gaveUp && (
        <p className="text-xs text-muted-foreground">{t("checkFailed")}</p>
      )}
      {(canRetry || status === "minted") && (
        <Link
          href={`/pay/${encodeURIComponent(serial)}`}
          className={buttonVariants({ variant: canRetry ? "default" : "outline" })}
        >
          {t("retry")}
        </Link>
      )}
    </div>
  );
}
