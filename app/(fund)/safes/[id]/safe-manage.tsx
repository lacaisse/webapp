// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Archive, CheckCircle2, Loader2, Pencil } from "lucide-react";
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
import { archiveSafeAction, renameSafeAction } from "@/services/safe/admin-actions";
import { RenameSafeSchema } from "@/services/safe/schemas";

// Rename + archive for one Safe. Archive only hides it from La Caisse — the
// Safe and its funds stay on chain — and is refused while transactions are
// still open, so nothing signed half-way gets lost from view.
export function SafeManage({
  safeId,
  name,
  openCount,
}: {
  safeId: string;
  name: string;
  openCount: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <RenameDialog safeId={safeId} name={name} />
      <ArchiveDialog safeId={safeId} openCount={openCount} />
    </div>
  );
}

function RenameDialog({ safeId, name }: { safeId: string; name: string }) {
  const t = useTranslations("fund.safes.rename");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setValue(name);
      setError(null);
    }
  }

  const onSubmit = () => {
    setError(null);
    const parsed = RenameSafeSchema.safeParse({ safeId, name: value });
    if (!parsed.success) {
      setError(tRoot(parsed.error.issues[0]!.message as never));
      return;
    }
    startTransition(async () => {
      const result = await renameSafeAction(parsed.data);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
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
            <Label htmlFor={`rename-safe-${safeId}`}>{t("name")}</Label>
            <Input
              id={`rename-safe-${safeId}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              maxLength={60}
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
            disabled={pending || value.trim() === "" || value.trim() === name}
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

function ArchiveDialog({
  safeId,
  openCount,
}: {
  safeId: string;
  openCount: number;
}) {
  const t = useTranslations("fund.safes.archive");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const blocked = openCount > 0;

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await archiveSafeAction({ safeId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      // The detail row is archived now (404 on re-render) — back to the list.
      router.push("/safes");
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(n) => {
        if (pending) return;
        setOpen(n);
        if (!n) setError(null);
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
          >
            <Archive className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {blocked && (
          <Alert variant="warning">
            <AlertDescription>
              {t("blocked", { count: openCount })}
            </AlertDescription>
          </Alert>
        )}
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
            disabled={pending || blocked}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Archive className="size-4" />
            )}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
