// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Loader2, Pencil, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  archiveTokenAccountAction,
  renameTokenAccountAction,
} from "@/services/token-account/admin-actions";

export function AccountManage({
  id,
  name,
  canArchive,
}: {
  id: string;
  name: string;
  canArchive: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <RenameDialog id={id} name={name} />
      {canArchive && <ArchiveDialog id={id} />}
    </div>
  );
}

function RenameDialog({ id, name }: { id: string; name: string }) {
  const t = useTranslations("fund.accounts.rename");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setValue(name);
      setError(null);
    }
  }

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result = await renameTokenAccountAction({ id, name: value.trim() });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Pencil className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`rename-${id}`}>{t("name")}</Label>
            <Input
              id={`rename-${id}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={pending || value.trim() === ""}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            {tRoot("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({ id }: { id: string }) {
  const t = useTranslations("fund.accounts.archive");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await archiveTokenAccountAction({ id });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      // The detail row is now archived (404 on re-render) — go to the list,
      // which the action revalidated.
      router.push("/accounts");
    });
  };

  return (
    <Dialog open={open} onOpenChange={(n) => !pending && setOpen(n)}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
