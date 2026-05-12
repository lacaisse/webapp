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
import { addCardAction } from "@/services/member/admin-actions";

// Link an additional card to an already-ACTIVE member (typically a
// dependant). The new card shares the primary's wallet on the CP side,
// so there's no spending-limit input here — just identity for the holder.

export function AddCardDialog({
  memberId,
  memberName,
}: {
  memberId: string;
  memberName: string;
}) {
  const t = useTranslations("members.admin.addCard");
  const [open, setOpen] = useState(false);
  const [serial, setSerial] = useState("");
  const [holderName, setHolderName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    if (!serial.trim()) {
      setError(t("serialRequired"));
      return;
    }
    startTransition(async () => {
      const result = await addCardAction({
        memberId,
        cardSerial: serial,
        holderName,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setSerial("");
      setHolderName("");
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { memberName })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`add-serial-${memberId}`}>
            {t("serialLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <Input
            id={`add-serial-${memberId}`}
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder={t("serialPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t("serialHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`holder-${memberId}`}>{t("holderLabel")}</Label>
          <Input
            id={`holder-${memberId}`}
            value={holderName}
            onChange={(e) => setHolderName(e.target.value)}
            placeholder={memberName}
            autoComplete="name"
          />
          <p className="text-xs text-muted-foreground">{t("holderHint")}</p>
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
            {pending ? t("adding") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
