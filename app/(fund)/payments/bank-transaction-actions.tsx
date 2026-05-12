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
import {
  linkBankTransactionAction,
  unlinkBankTransactionAction,
} from "@/services/bank-sync/admin-actions";

export function BankTransactionRowActions({
  bankTransactionId,
  isMatched,
}: {
  bankTransactionId: string;
  isMatched: boolean;
}) {
  if (isMatched) {
    return <UnlinkButton bankTransactionId={bankTransactionId} />;
  }
  return <LinkDialog bankTransactionId={bankTransactionId} />;
}

function LinkDialog({ bankTransactionId }: { bankTransactionId: string }) {
  const t = useTranslations("fund.payments.admin.link");
  const [open, setOpen] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    if (!identifier.trim()) {
      setError(t("identifierRequired"));
      return;
    }
    startTransition(async () => {
      const result = await linkBankTransactionAction({
        bankTransactionId,
        identifier,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setIdentifier("");
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
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`link-${bankTransactionId}`}>
            {t("identifierLabel")}
          </Label>
          <Input
            id={`link-${bankTransactionId}`}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t("identifierPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t("identifierHint")}</p>
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
            {pending ? t("linking") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnlinkButton({ bankTransactionId }: { bankTransactionId: string }) {
  const t = useTranslations("fund.payments.admin.link");
  const [pending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(async () => {
      await unlinkBankTransactionAction({ bankTransactionId });
    });
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={pending}
    >
      {pending ? t("unlinking") : t("unlinkButton")}
    </Button>
  );
}
