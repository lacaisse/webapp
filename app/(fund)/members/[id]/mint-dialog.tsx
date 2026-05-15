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
import { manualMintAction } from "@/services/token-operations/admin-actions";

export function MintDialog({
  memberId,
  memberName,
}: {
  memberId: string;
  memberName: string;
}) {
  const t = useTranslations("members.admin.mint");
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    if (!amount.trim()) {
      setError(t("amountRequired"));
      return;
    }
    startTransition(async () => {
      const result = await manualMintAction({
        memberId,
        amount: amount.trim(),
        note: note.trim() || undefined,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setAmount("");
      setNote("");
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
          <Label htmlFor={`mint-amount-${memberId}`}>
            {t("amountLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <Input
            id={`mint-amount-${memberId}`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="25.00"
            inputMode="decimal"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">{t("amountHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`mint-note-${memberId}`}>{t("noteLabel")}</Label>
          <textarea
            id={`mint-note-${memberId}`}
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
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? t("minting") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
