// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CalendarRange, CheckCircle2, Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
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
import { updatePayoutPeriodAction } from "@/services/payout/admin-actions";

// `YYYY-MM-DD` in UTC — the stored dates are UTC midnights, so reading them
// back with the local getters would shift the day west of Greenwich.
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The month input works in `YYYY-MM`; the range it stands for is the whole
// calendar month as a half-open [1st, 1st-of-next) pair.
function monthOf(day: string): string {
  return day.slice(0, 7);
}

function monthRange(month: string): { from: string; to: string } | null {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return null;
  return {
    from: isoDay(new Date(Date.UTC(y, m - 1, 1))),
    to: isoDay(new Date(Date.UTC(y, m, 1))),
  };
}

// Edit a pending payout's settlement period. This only relabels the payout:
// its orders were claimed by CitizenPay at creation and stay linked, so
// widening the window pulls in nothing and moves no money — which is exactly
// what makes it safe to offer. The common case is a payout that should read as
// a calendar month but was created over the range that happened to hold orders
// (1–28 July), so the month picker fills both dates in one go.
export function PayoutPeriodDialog({
  payoutId,
  startDate,
  endDate,
}: {
  payoutId: string;
  startDate: string; // ISO 8601
  endDate: string; // ISO 8601
}) {
  const t = useTranslations("fund.payments.settlement.editPeriod");
  const tRoot = useTranslations();
  const format = useFormatter();

  const initialFrom = isoDay(new Date(startDate));
  const initialTo = isoDay(new Date(endDate));

  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFrom(initialFrom);
      setTo(initialTo);
      setError(null);
    }
  }

  function onMonthChange(month: string) {
    const range = monthRange(month);
    if (!range) return;
    setFrom(range.from);
    setTo(range.to);
  }

  // Half-open, same invariant the server re-checks.
  const valid = from !== "" && to !== "" && from < to;
  const unchanged = from === initialFrom && to === initialTo;

  // The end date is exclusive, so the period covers up to the day before it —
  // spell that out rather than making the operator reason about it.
  const lastDay = valid
    ? format.dateTime(new Date(`${to}T00:00:00Z`), {
        dateStyle: "medium",
        timeZone: "UTC",
      })
    : null;
  const firstDay = valid
    ? format.dateTime(new Date(`${from}T00:00:00Z`), {
        dateStyle: "medium",
        timeZone: "UTC",
      })
    : null;

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await updatePayoutPeriodAction({ payoutId, from, to });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // The action revalidated the detail path and called refresh(), so the
      // header re-renders with the new period — just close.
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <CalendarRange className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`period-month-${payoutId}`}>{t("month")}</Label>
            <Input
              id={`period-month-${payoutId}`}
              type="month"
              value={monthOf(from)}
              onChange={(e) => onMonthChange(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("monthHint")}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor={`period-from-${payoutId}`}>{t("from")}</Label>
              <Input
                id={`period-from-${payoutId}`}
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`period-to-${payoutId}`}>{t("to")}</Label>
              <Input
                id={`period-to-${payoutId}`}
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>

          {valid && (
            <div className="rounded-lg border border-border px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {t("covers", { from: firstDay!, to: lastDay! })}
              </span>
            </div>
          )}

          <p className="text-xs text-muted-foreground">{t("ordersHint")}</p>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={pending || !valid || unchanged}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
