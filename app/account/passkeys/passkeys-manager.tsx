"use client";

import { startRegistration } from "@simplewebauthn/browser";
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
import { deletePasskeyAction } from "@/services/auth/passkey-actions";

export type PasskeyRow = {
  id: string;
  nickname: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
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
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onRegister = () => {
    setError(null);
    startTransition(async () => {
      try {
        const optionsRes = await fetch("/api/webauthn/register/options", {
          method: "POST",
        });
        if (!optionsRes.ok) throw new Error(tErrCommon("passkeyStartFailed"));
        const options = await optionsRes.json();

        const attResp = await startRegistration({ optionsJSON: options });

        const verifyRes = await fetch("/api/webauthn/register/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: attResp, nickname }),
        });
        const verifyJson = await verifyRes.json();
        if (!verifyRes.ok) {
          throw new Error(verifyJson.error ?? tErrCommon("passkeyVerifyFailed"));
        }

        setOpen(false);
        setNickname("");
        router.refresh();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : t("errors.generic"),
        );
      }
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
            <Label htmlFor="nickname">{t("nickname")}</Label>
            <Input
              id="nickname"
              placeholder={t("nicknamePlaceholder")}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
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

function PasskeyRow({ passkey }: { passkey: PasskeyRow }) {
  const t = useTranslations("account.passkeys");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const onDelete = () =>
    startTransition(async () => {
      const result = await deletePasskeyAction(passkey.id);
      if ("error" in result) return;
      setConfirmOpen(false);
      router.refresh();
    });

  const dateFmt = (d: string) =>
    format.dateTime(new Date(d), { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="flex items-center justify-between rounded-lg border bg-card p-3">
      <div className="space-y-0.5">
        <div className="font-medium">
          {passkey.nickname ?? t("rowUnnamed")}
        </div>
        <div className="text-xs text-muted-foreground">
          {passkey.deviceType === "multiDevice"
            ? t("rowSynced")
            : t("rowDeviceBound")}
          {" · "}
          {t("rowAdded", { date: dateFmt(passkey.createdAt) })}
          {passkey.lastUsedAt && (
            <>
              {" · "}
              {t("rowLastUsed", { date: dateFmt(passkey.lastUsedAt) })}
            </>
          )}
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
              {passkey.nickname
                ? t.rich("deleteDescriptionNamed", {
                    name: passkey.nickname,
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
