// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Fingerprint, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
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
import { passkey } from "@/services/auth/client";

export type PasskeyRow = {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
};

export function PasskeysManager({ passkeys }: { passkeys: PasskeyRow[] }) {
  const t = useTranslations("account.passkeys");
  const count = passkeys.length;
  const summary =
    count === 0
      ? t("empty")
      : count === 1
        ? t("countOne", { count })
        : t("countOther", { count });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{summary}</p>
        <RegisterPasskeyDialog />
      </div>
      <div className="space-y-2">
        {passkeys.map((p) => (
          <PasskeyRow key={p.id} passkey={p} />
        ))}
      </div>
    </div>
  );
}

function RegisterPasskeyDialog() {
  const t = useTranslations("account.passkeys");
  const tErrCommon = useTranslations("auth.errors");
  const tCommon = useTranslations("common");

  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onRegister = () => {
    setError(null);
    startTransition(async () => {
      // addPasskey runs the WebAuthn registration ceremony against
      // /api/auth/passkey/{generate-register-options,verify-registration}
      // and creates the Passkey row on success.
      const result = await passkey.addPasskey({ name: name || undefined });
      if (result?.error) {
        setError(result.error.message ?? tErrCommon("passkeyVerifyFailed"));
        return;
      }

      setOpen(false);
      setName("");
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="default">
            <Fingerprint className="size-4" />
            {t("addButton")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("registerTitle")}</DialogTitle>
          <DialogDescription>{t("registerDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="passkey-name">{t("nickname")}</Label>
            <Input
              id="passkey-name"
              placeholder={t("nicknamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
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
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {tCommon("cancel")}
          </Button>
          <Button onClick={onRegister} disabled={pending}>
            {pending ? t("registerWaiting") : t("registerSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasskeyRow({ passkey: pk }: { passkey: PasskeyRow }) {
  const t = useTranslations("account.passkeys");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const onDelete = () =>
    startTransition(async () => {
      const result = await passkey.deletePasskey({ id: pk.id });
      if (result?.error) return;
      setConfirmOpen(false);
      router.refresh();
    });

  const dateFmt = (d: string) =>
    format.dateTime(new Date(d), { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="flex items-center justify-between rounded-lg border bg-card p-3">
      <div className="space-y-0.5">
        <div className="font-medium">{pk.name ?? t("rowUnnamed")}</div>
        <div className="text-xs text-muted-foreground">
          {pk.deviceType === "multiDevice"
            ? t("rowSynced")
            : t("rowDeviceBound")}
          {" · "}
          {t("rowAdded", { date: dateFmt(pk.createdAt) })}
        </div>
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("deleteAriaLabel")}
            >
              <Trash2 className="size-4" />
            </Button>
          }
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {pk.name
                ? t.rich("deleteDescriptionNamed", {
                    name: pk.name,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })
                : t("deleteDescriptionUnnamed")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={pending}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={pending}
            >
              {pending ? t("deleting") : t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
