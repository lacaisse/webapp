// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Fingerprint } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
} from "@/components/ui/dialog";
import { passkey } from "@/services/auth/client";

// Shown once, right after sign-up, when the apex picker is reached with
// `?welcome=passkey` and the user has no passkeys yet (both checked
// server-side before this renders). Auto-opens and offers a one-tap passkey
// registration. Dismissing — or finishing — strips the query param so a
// refresh doesn't reopen it.
export function PasskeySuggestion() {
  const t = useTranslations("account.suggestPasskey");
  const tErr = useTranslations("auth.errors");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const clearParam = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("welcome");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const dismiss = () => {
    setOpen(false);
    clearParam();
  };

  const onAccept = () => {
    setError(null);
    startTransition(async () => {
      const result = await passkey.addPasskey();
      if (result?.error) {
        setError(result.error.message ?? tErr("passkeyVerifyFailed"));
        return;
      }
      setOpen(false);
      clearParam();
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
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
          <Button variant="ghost" onClick={dismiss} disabled={pending}>
            {t("dismiss")}
          </Button>
          <Button onClick={onAccept} disabled={pending}>
            <Fingerprint className="size-4" />
            {pending ? t("accepting") : t("accept")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
