// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
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
import {
  createPayoutAction,
  previewPayoutDraftAction,
  type PreviewPayoutResult,
} from "@/services/payout/admin-actions";

// Roll a place's unpaid orders into a pending payout. The admin picks a
// half-open [from, to) range, previews the live count/total, then commits —
// which atomically claims those orders on CP's side.
export function CreatePayoutDialog({
  placeId,
  placeName,
}: {
  placeId: string;
  placeName: string;
}) {
  const t = useTranslations("fund.payments.settlement.create");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const defaults = lastMonthRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [preview, setPreview] = useState<Extract<
    PreviewPayoutResult,
    { ok: true }
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  const [creating, startCreate] = useTransition();

  function reset() {
    const d = lastMonthRange();
    setFrom(d.from);
    setTo(d.to);
    setPreview(null);
    setError(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  // Re-previewing is what keeps the count/total honest after a range edit;
  // clear the stale preview the moment either bound changes.
  function onRange(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setPreview(null);
    };
  }

  const onPreview = () => {
    setError(null);
    startPreview(async () => {
      const result = await previewPayoutDraftAction({ placeId, from, to });
      if ("error" in result) {
        setError(result.error);
        setPreview(null);
        return;
      }
      setPreview(result);
    });
  };

  const onCreate = () => {
    setError(null);
    startCreate(async () => {
      const result = await createPayoutAction({ placeId, from, to });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    });
  };

  const euro = (v: string) =>
    format.number(Number(v), { style: "currency", currency: "EUR" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="default" size="sm" />}>
        {t("trigger")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title", { place: placeName })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor={`from-${placeId}`}>{t("from")}</Label>
              <Input
                id={`from-${placeId}`}
                type="date"
                value={from}
                onChange={(e) => onRange(setFrom)(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`to-${placeId}`}>{t("to")}</Label>
              <Input
                id={`to-${placeId}`}
                type="date"
                value={to}
                onChange={(e) => onRange(setTo)(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("rangeHint")}</p>

          {preview && (
            <Alert>
              <AlertDescription>
                <div className="flex items-center justify-between gap-4">
                  <span>{t("previewOrders", { count: preview.orderCount })}</span>
                  <span className="font-medium">{euro(preview.net)}</span>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onPreview}
            disabled={previewing || creating}
          >
            {previewing && <Loader2 className="size-4 animate-spin" />}
            {t("preview")}
          </Button>
          <Button
            type="button"
            onClick={onCreate}
            disabled={creating || previewing || preview?.orderCount === 0}
          >
            {creating ? (
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

// Default to the previous calendar month as a half-open range:
// [first-of-last-month, first-of-this-month). Local time is fine — the
// action widens these date-only strings to UTC midnight.
function lastMonthRange(): { from: string; to: string } {
  const now = new Date();
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { from: iso(firstLast), to: iso(firstThis) };
}

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
