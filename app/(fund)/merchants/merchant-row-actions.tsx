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
import {
  approveMerchantAction,
  reconsiderMerchantAction,
  rejectMerchantAction,
} from "@/services/merchant/admin-actions";

// Approve / Reject buttons + dialogs. Approve has an optional note; Reject
// requires a reason (visible to the merchant in the email). Both dialogs
// confirm before firing the server action — approvals send emails which
// are awkward to walk back.

export function MerchantRowActions({
  merchantId,
  merchantName,
  emailVerified,
  status,
}: {
  merchantId: string;
  merchantName: string;
  emailVerified: boolean;
  status: "PENDING" | "ACTIVE" | "INACTIVE" | "REJECTED";
}) {
  if (status === "REJECTED") {
    return <ReconsiderButton merchantId={merchantId} />;
  }
  if (status !== "PENDING") return null;
  return (
    <div className="inline-flex items-center gap-2">
      <ApproveButton
        merchantId={merchantId}
        merchantName={merchantName}
        emailVerified={emailVerified}
      />
      <RejectButton merchantId={merchantId} merchantName={merchantName} />
    </div>
  );
}

function ReconsiderButton({ merchantId }: { merchantId: string }) {
  const t = useTranslations("merchants.admin.review");
  const [pending, startTransition] = useTransition();
  const onClick = () => {
    startTransition(async () => {
      await reconsiderMerchantAction({ merchantId });
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      {pending ? t("reconsidering") : t("reconsider")}
    </Button>
  );
}

function ApproveButton({
  merchantId,
  merchantName,
  emailVerified,
}: {
  merchantId: string;
  merchantName: string;
  emailVerified: boolean;
}) {
  const t = useTranslations("merchants.admin.review");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onApprove = () => {
    setError(null);
    startTransition(async () => {
      const result = await approveMerchantAction({ merchantId, note });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setNote("");
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="default" size="sm" />}>
        {t("approve")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("approveTitle")}</DialogTitle>
          <DialogDescription>
            {t("approveDescription", { merchantName })}
          </DialogDescription>
        </DialogHeader>
        {!emailVerified && (
          <Alert variant="warning">
            <AlertDescription>{t("approveUnverifiedWarning")}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor={`approve-note-${merchantId}`}>
            {t("approveNoteLabel")}
          </Label>
          <textarea
            id={`approve-note-${merchantId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("approveNotePlaceholder")}
            className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
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
          <Button onClick={onApprove} disabled={pending}>
            {pending ? t("approving") : t("approveConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectButton({
  merchantId,
  merchantName,
}: {
  merchantId: string;
  merchantName: string;
}) {
  const t = useTranslations("merchants.admin.review");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onReject = () => {
    setError(null);
    if (!note.trim()) {
      setError(t("reasonRequired"));
      return;
    }
    startTransition(async () => {
      const result = await rejectMerchantAction({ merchantId, note });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setNote("");
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        {t("reject")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("rejectTitle")}</DialogTitle>
          <DialogDescription>
            {t("rejectDescription", { merchantName })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`reject-note-${merchantId}`}>
            {t("rejectReasonLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <textarea
            id={`reject-note-${merchantId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("rejectReasonPlaceholder")}
            className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            required
          />
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
          <Button variant="destructive" onClick={onReject} disabled={pending}>
            {pending ? t("rejecting") : t("rejectConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
