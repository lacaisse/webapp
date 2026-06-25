// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Link2, Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import {
  attachAllocationToDepositAction,
  listManualAllocationsAction,
  type PickableManualAllocation,
} from "@/services/allocation-periods/manual-allocation-actions";

// Attach an existing manual allocation to this deposit, instead of running a
// fresh one — for when the admin already minted by hand (card recharge, member
// mint) for a payment that later landed as a bank deposit. Lists the deposit
// member's loose manual mints; picking one links it and flips the deposit to
// "allocated".
export function AttachAllocationDialog({
  bankTransactionId,
  memberName,
  depositAmount,
}: {
  bankTransactionId: string;
  memberName: string;
  depositAmount: string;
}) {
  const t = useTranslations("fund.allocations.periodDetail.attachAllocation");
  const tRoot = useTranslations();
  const format = useFormatter();

  const [open, setOpen] = useState(false);
  const [allocations, setAllocations] = useState<
    PickableManualAllocation[] | null
  >(null);
  const [loading, startLoad] = useTransition();
  const [pending, startAttach] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    startLoad(async () => {
      const res = await listManualAllocationsAction({ bankTransactionId });
      if ("error" in res) {
        setAllocations([]);
        setError(res.error);
        return;
      }
      setAllocations(res.allocations);
    });
  }, [open, bankTransactionId]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setAllocations(null);
      setError(null);
    }
  }

  const attach = (tokenOperationId: string) => {
    setError(null);
    startAttach(async () => {
      const result = await attachAllocationToDepositAction({
        bankTransactionId,
        tokenOperationId,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Link2 className="size-4" />
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { member: memberName, amount: depositAmount })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0">
          {loading && allocations === null ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : allocations && allocations.length > 0 ? (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {allocations.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={pending}
                  onClick={() => attach(a.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium tabular-nums">
                      {a.amount}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {format.dateTime(new Date(a.submittedAt), {
                        dateStyle: "medium",
                      })}
                      {a.tierName ? ` · ${a.tierName}` : ""}
                      {a.periodLabel
                        ? ` · ${t("inPeriod", { period: a.periodLabel })}`
                        : ""}
                    </div>
                  </div>
                  <Badge
                    variant={a.status === "CONFIRMED" ? "success" : "warning"}
                  >
                    {a.status}
                  </Badge>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border py-6 text-center text-sm text-muted-foreground">
              {t("empty")}
            </div>
          )}

          {error && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
