// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { removeMemberLoginAction } from "@/services/member/auth-actions";

// "Remove my login" — irreversible for the login (the membership itself
// stays, as an admin-managed record), so it goes through an in-app
// confirmation. The cards become public again at Citizen Pay.
export function RemoveLoginCard() {
  const t = useTranslations("memberLogin.account.remove");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      const result = await removeMemberLoginAction();
      if ("error" in result) setError(result.error);
      else if (result.redirectTo) window.location.assign(result.redirectTo);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button variant="destructive">{t("button")}</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("confirmTitle")}</DialogTitle>
              <DialogDescription>{t("confirmDescription")}</DialogDescription>
            </DialogHeader>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                {tCommon("cancel")}
              </Button>
              <Button variant="destructive" onClick={confirm} disabled={pending}>
                {pending ? t("removing") : t("confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
