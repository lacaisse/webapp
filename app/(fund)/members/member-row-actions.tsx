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
import { activateMemberAction } from "@/services/member/admin-actions";

import { UnattachedCardPicker } from "./unattached-card-picker";

// Activation = link a physical card to the member. The admin picks an
// already-imported (CitizenPay-synced) unattached card from the typeahead
// rather than typing a serial — that way the on-chain account is already
// known locally and we don't need a fresh CP registerCard roundtrip.

export function MemberRowActions({
  memberId,
  memberName,
  emailVerified,
}: {
  memberId: string;
  memberName: string;
  emailVerified: boolean;
}) {
  const t = useTranslations("members.admin.activate");
  const [open, setOpen] = useState(false);
  const [cardId, setCardId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pickerLabels = {
    field: t("cardLabel"),
    placeholder: t("cardPlaceholder"),
    hint: t("cardHint"),
    searching: t("cardSearching"),
    empty: t("cardEmpty"),
    emptyInitial: t("cardEmptyInitial"),
    noAccount: t("cardNoAccount"),
    clear: t("cardClear"),
  };

  const onActivate = () => {
    setError(null);
    if (!cardId) {
      setError(t("cardRequired"));
      return;
    }
    startTransition(async () => {
      const result = await activateMemberAction({
        memberId,
        cardId,
        note,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setCardId(null);
      setNote("");
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="default" size="sm" />}>
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { memberName })}
          </DialogDescription>
        </DialogHeader>
        {!emailVerified && (
          <Alert variant="warning">
            <AlertDescription>{t("unverifiedWarning")}</AlertDescription>
          </Alert>
        )}
        <UnattachedCardPicker
          id={`activate-card-${memberId}`}
          labels={pickerLabels}
          value={cardId}
          onChange={(next) => setCardId(next?.id ?? null)}
          error={null}
        />
        <div className="space-y-2">
          <Label htmlFor={`activate-note-${memberId}`}>{t("noteLabel")}</Label>
          <textarea
            id={`activate-note-${memberId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={t("notePlaceholder")}
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
          <Button onClick={onActivate} disabled={pending}>
            {pending ? t("activating") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
