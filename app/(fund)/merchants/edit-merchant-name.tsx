// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Pencil } from "lucide-react";
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
import { updateMerchantNameAction } from "@/services/merchant/admin-actions";

// Edit the merchant's public name from the detail page header. Small pencil
// trigger → dialog with a single field. The action revalidates the page, so
// the header reflects the new name on success.
export function EditMerchantName({
  merchantId,
  currentName,
}: {
  merchantId: string;
  currentName: string;
}) {
  const t = useTranslations("merchants.admin.editName");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (!next && pending) return;
    setOpen(next);
    setError(null);
    if (next) setName(currentName);
  }

  function onSave() {
    setError(null);
    startTransition(async () => {
      const result = await updateMerchantNameAction({ merchantId, name });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("trigger")}
          >
            <Pencil className="size-4" />
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`merchant-name-${merchantId}`}>{t("label")}</Label>
          <Input
            id={`merchant-name-${merchantId}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("placeholder")}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSave();
              }
            }}
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
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={onSave} disabled={pending || !name.trim()}>
            {pending ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
