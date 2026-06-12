// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Coins } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
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
import { allocatePeriodMemberAction } from "@/services/allocation-periods/run-actions";

// Single allocation run: mint one member's tier allocation for this period,
// after confirmation (an on-chain mint can't be undone). The main use case is
// a late payment attributed to a period after its close — the member shows up
// as "ready to allocate" and the admin mints just them.
export function AllocateMemberButton({
  periodId,
  memberId,
  memberName,
  amount,
  periodLabel,
}: {
  periodId: string;
  memberId: string;
  memberName: string;
  amount: string;
  periodLabel: string;
}) {
  const t = useTranslations("fund.allocations.periodDetail.allocateMember");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const allocate = () => {
    setError(null);
    startTransition(async () => {
      const result = await allocatePeriodMemberAction({ periodId, memberId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Coins className="size-3.5" />
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", {
              name: memberName,
              amount,
              period: periodLabel,
            })}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={allocate} disabled={pending}>
            {pending ? t("minting") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
