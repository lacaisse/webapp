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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { activateMemberAction } from "@/services/member/admin-actions";

// Activation = link a physical card. Admin scans / types the NFC serial
// from the card they're handing out; we store it as the primary card and
// flip Member.status to ACTIVE. The CitizenPay wallet address is populated
// later when CP integration registers the card.

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
  const [serial, setSerial] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onActivate = () => {
    setError(null);
    if (!serial.trim()) {
      setError(t("serialRequired"));
      return;
    }
    startTransition(async () => {
      const result = await activateMemberAction({
        memberId,
        cardSerial: serial,
        note,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setSerial("");
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
        <div className="space-y-2">
          <Label htmlFor={`serial-${memberId}`}>
            {t("serialLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <Input
            id={`serial-${memberId}`}
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder={t("serialPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t("serialHint")}</p>
        </div>
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
