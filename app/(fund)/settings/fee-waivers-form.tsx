// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition } from "react";

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
import {
  addFeeWaiverAction,
  removeFeeWaiverAction,
} from "@/services/fund/fee-waiver-actions";
import type { FeeWaiverBusiness, FeeWaiverState } from "@/services/fund/fee-waivers";

// Settings → Fees, under the fee form: the businesses Citizen Pay does not
// charge the fixed fee per order (the percentage still applies). The list
// comes from Citizen Pay (read server-side); adding picks one of the fund's
// merchants grouped by business, removing goes through a confirm dialog. Both
// update the list optimistically and the actions revalidate /settings.

type Optimistic =
  | { kind: "add"; business: FeeWaiverBusiness }
  | { kind: "remove"; businessId: string };

// "Business name — Place A, Place B", falling back to whichever is known.
function businessLabel(b: FeeWaiverBusiness): string {
  const places = b.placeNames.join(", ");
  if (b.businessName && places && b.businessName !== places) {
    return `${b.businessName} — ${places}`;
  }
  return b.businessName || places || b.businessId;
}

export function FeeWaiversForm({ state }: { state: FeeWaiverState }) {
  const t = useTranslations("fund.settings.fees.waivers");

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      {state.status === "ok" ? (
        <WaiverList waivers={state.waivers} candidates={state.candidates} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {state.status === "not_connected"
            ? t("notConnected")
            : state.status === "unavailable"
              ? t("unavailable")
              : t("loadFailed")}
        </p>
      )}
    </div>
  );
}

function WaiverList({
  waivers,
  candidates,
}: {
  waivers: FeeWaiverBusiness[];
  candidates: FeeWaiverBusiness[];
}) {
  const t = useTranslations("fund.settings.fees.waivers");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, startAdding] = useTransition();
  const [optimistic, apply] = useOptimistic(waivers, (rows, op: Optimistic) =>
    op.kind === "add"
      ? rows.some((r) => r.businessId === op.business.businessId)
        ? rows
        : [...rows, op.business]
      : rows.filter((r) => r.businessId !== op.businessId),
  );
  const waived = new Set(optimistic.map((w) => w.businessId));
  const available = candidates.filter((c) => !waived.has(c.businessId));
  // A selection that was just added (or vanished) no longer counts.
  const choice = available.some((c) => c.businessId === selected) ? selected : "";

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const business = available.find((c) => c.businessId === choice);
    if (!business) return;
    startAdding(async () => {
      apply({ kind: "add", business });
      const result = await addFeeWaiverAction({ businessId: business.businessId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSelected("");
    });
  };

  return (
    <>
      {optimistic.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {optimistic.map((w) => (
            <li key={w.businessId} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="truncate text-sm font-medium">
                  {w.businessName || w.placeNames[0] || w.businessId}
                </div>
                {w.placeNames.length > 0 && (
                  <div className="truncate text-xs text-muted-foreground">
                    {t("places", { places: w.placeNames.join(", ") })}
                  </div>
                )}
              </div>
              <RemoveWaiverButton
                business={w}
                onRemoved={(businessId) => apply({ kind: "remove", businessId })}
                onError={setError}
              />
            </li>
          ))}
        </ul>
      )}

      {available.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {candidates.length === 0 ? t("noMerchants") : t("allExempt")}
        </p>
      ) : (
        <form onSubmit={onAdd} className="space-y-2">
          <Label htmlFor="fee-waiver-business">{t("business")}</Label>
          <div className="flex gap-2">
            <select
              id="fee-waiver-business"
              value={choice}
              onChange={(e) => {
                setSelected(e.target.value);
                setError(null);
              }}
              disabled={adding}
              className="h-8 w-full min-w-0 rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t("businessPlaceholder")}</option>
              {available.map((c) => (
                <option key={c.businessId} value={c.businessId}>
                  {businessLabel(c)}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={adding || choice === ""}>
              {adding ? <Loader2 className="animate-spin" /> : <Plus />}
              {adding ? t("adding") : t("add")}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

function RemoveWaiverButton({
  business,
  onRemoved,
  onError,
}: {
  business: FeeWaiverBusiness;
  onRemoved: (businessId: string) => void;
  onError: (message: string | null) => void;
}) {
  const t = useTranslations("fund.settings.fees.waivers");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const onConfirm = () => {
    onError(null);
    startTransition(async () => {
      onRemoved(business.businessId);
      const result = await removeFeeWaiverAction({ businessId: business.businessId });
      setOpen(false);
      if ("error" in result) onError(result.error);
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("remove")}
            title={t("remove")}
          >
            <Trash2 className="text-muted-foreground" />
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("remove")}</DialogTitle>
          <DialogDescription>
            {t("confirmRemove", { business: businessLabel(business) })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {t("remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
