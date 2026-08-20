// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

import { CardPicker } from "./card-picker";

// Activation = link a physical card to the member. The admin picks an
// already-imported (CitizenPay-synced) unattached card from the typeahead
// rather than typing a serial — that way the on-chain account is already
// known locally and we don't need a fresh CP registerCard roundtrip.

export function MemberRowActions({
  memberId,
  memberName,
  emailVerified,
  // The member is already ACTIVE but has no primary card (e.g. imported active
  // with no matching serial). Same flow, but we're assigning a card rather than
  // activating — the wording and the welcome email change accordingly.
  alreadyActive = false,
}: {
  memberId: string;
  memberName: string;
  emailVerified: boolean;
  alreadyActive?: boolean;
}) {
  const t = useTranslations("members.admin.activate");
  const [open, setOpen] = useState(false);
  const [cardId, setCardId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sendCardEmail, setSendCardEmail] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pickerLabels = {
    field: t("cardLabel"),
    choose: t("cardChoose"),
    modalTitle: t("cardModalTitle"),
    modalDescription: t("cardModalDescription"),
    placeholder: t("cardPlaceholder"),
    hint: t("cardHint"),
    searching: t("cardSearching"),
    empty: t("cardEmpty"),
    emptyInitial: t("cardEmptyInitial"),
    available: t("cardAvailable"),
    unavailable: t("cardUnavailable"),
    assignedTo: (name: string) => t("cardAssignedTo", { name }),
    blocked: t("cardBlockedBadge"),
    lost: t("cardLostBadge"),
    noNumber: t("cardNoNumber"),
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
        sendCardEmail,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setCardId(null);
      setNote("");
      setSendCardEmail(true);
    });
  };

  // Assigning to an already-active member is the same flow with card-centric
  // wording (no "becomes active", no welcome email).
  const labels = alreadyActive
    ? {
        button: t("assignButton"),
        title: t("assignTitle"),
        description: t("assignDescription", { memberName }),
        confirm: t("assignConfirm"),
        pending: t("assigning"),
      }
    : {
        button: t("button"),
        title: t("title"),
        description: t("description", { memberName }),
        confirm: t("confirm"),
        pending: t("activating"),
      };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant={alreadyActive ? "outline" : "default"}
            size="sm"
          />
        }
      >
        {labels.button}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        {!emailVerified && !alreadyActive && (
          <Alert variant="warning">
            <AlertDescription>{t("unverifiedWarning")}</AlertDescription>
          </Alert>
        )}
        <CardPicker
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
        <div className="flex items-start gap-2 pt-1">
          <Checkbox
            id={`activate-card-email-${memberId}`}
            checked={sendCardEmail}
            onCheckedChange={(value) => setSendCardEmail(value)}
            className="mt-0.5"
          />
          <Label
            htmlFor={`activate-card-email-${memberId}`}
            className="text-sm font-normal text-muted-foreground"
          >
            {t("sendCardEmailLabel")}
          </Label>
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
            {pending ? labels.pending : labels.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
