// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

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
import { Label } from "@/components/ui/label";
import type { MemberStatus } from "@/services/db/generated/enums";
import { changeMemberStatusAction } from "@/services/member/status-actions";
import { MEMBER_STATUS_TRANSITIONS } from "@/services/member/status-config";

export function StatusChangeDialog({
  memberId,
  memberName,
  currentStatus,
}: {
  memberId: string;
  memberName: string;
  currentStatus: MemberStatus;
}) {
  const t = useTranslations("members.admin.status");
  const [open, setOpen] = useState(false);
  // Only the transitions valid from the current status (issue #17).
  const options = MEMBER_STATUS_TRANSITIONS[currentStatus];
  const [target, setTarget] = useState<MemberStatus>(
    options[0] ?? currentStatus,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result = await changeMemberStatusAction({
        memberId,
        status: target,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", {
              memberName,
              currentStatus: t(`values.${currentStatus}`),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`status-${memberId}`}>{t("targetLabel")}</Label>
          <select
            id={`status-${memberId}`}
            value={target}
            onChange={(e) => setTarget(e.target.value as MemberStatus)}
            className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {t(`values.${opt}`)}
              </option>
            ))}
          </select>
          {target === "STOPPED" && (
            <p className="text-xs text-warning">{t("stoppedWarning")}</p>
          )}
        </div>
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
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? t("saving") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
