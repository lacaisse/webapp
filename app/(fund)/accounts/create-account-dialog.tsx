// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, KeyRound, Loader2, Plus, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";

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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { createTokenAccountAction } from "@/services/token-account/admin-actions";

import { SafeCreateForm, type SafeMemberOption } from "./safes/safe-create-form";

type Security = "fundKey" | "safe";

// One "New account" entry point. An account is either controlled by the
// fund's key (derived from the minter EOA) or by several signatures (a Safe);
// the dialog offers whichever of the two this fund can create.
export function CreateAccountDialog({
  canCreateAccount,
  canCreateSafe,
  members,
  currentUserId,
}: {
  canCreateAccount: boolean;
  canCreateSafe: boolean;
  members: SafeMemberOption[];
  currentUserId: string;
}) {
  const t = useTranslations("fund.accounts.create");
  const tSafes = useTranslations("fund.safes.create");
  const router = useRouter();
  const defaultSecurity: Security = canCreateAccount ? "fundKey" : "safe";

  const [open, setOpen] = useState(false);
  const [security, setSecurity] = useState<Security>(defaultSecurity);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  // Bumped on every close so both forms remount with fresh state.
  const [formKey, setFormKey] = useState(0);

  const onPendingChange = useCallback((p: boolean) => setPending(p), []);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setName("");
      setSecurity(defaultSecurity);
      setFormKey((k) => k + 1);
    }
  }

  function close() {
    setPending(false);
    setOpen(false);
    setName("");
    setSecurity(defaultSecurity);
    setFormKey((k) => k + 1);
  }

  if (!canCreateAccount && !canCreateSafe) return null;
  const showChoice = canCreateAccount && canCreateSafe;
  const isSafe = security === "safe";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent
        className={cn(isSafe && "max-h-[90vh] overflow-y-auto sm:max-w-lg")}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {isSafe ? tSafes("description") : t("description")}
          </DialogDescription>
        </DialogHeader>

        {showChoice && (
          <div className="space-y-2">
            <div id="account-security-label" className="text-sm font-medium">
              {t("securityLabel")}
            </div>
            <div
              role="radiogroup"
              aria-labelledby="account-security-label"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <SecurityOption
                selected={security === "fundKey"}
                onSelect={() => setSecurity("fundKey")}
                disabled={pending}
                icon={<KeyRound className="size-4" />}
                title={t("securityFundKey")}
                hint={t("securityFundKeyHint")}
              />
              <SecurityOption
                selected={security === "safe"}
                onSelect={() => setSecurity("safe")}
                disabled={pending}
                icon={<ShieldCheck className="size-4" />}
                title={t("securitySafe")}
                hint={t("securitySafeHint")}
              />
            </div>
          </div>
        )}

        {isSafe ? (
          <SafeCreateForm
            key={`safe-${formKey}`}
            name={name}
            onNameChange={setName}
            members={members}
            currentUserId={currentUserId}
            onCancel={() => onOpenChange(false)}
            onPendingChange={onPendingChange}
            onCreated={(safeId) => {
              close();
              router.push(`/accounts/safes/${safeId}`);
            }}
          />
        ) : (
          <FundKeyAccountForm
            key={`account-${formKey}`}
            name={name}
            onNameChange={setName}
            onCancel={() => onOpenChange(false)}
            onPendingChange={onPendingChange}
            onCreated={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// A selectable card for the security choice, built on Button.
function SecurityOption({
  selected,
  onSelect,
  disabled,
  icon,
  title,
  hint,
}: {
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={selected}
      variant="outline"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "h-auto flex-col items-start gap-1 px-3 py-2.5 text-left whitespace-normal",
        selected && "border-primary bg-muted ring-1 ring-primary",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {title}
      </span>
      <span className="text-xs font-normal text-muted-foreground">{hint}</span>
    </Button>
  );
}

// The "fund key" body: an account derived from the fund's minter key,
// optionally a card-source account.
function FundKeyAccountForm({
  name,
  onNameChange,
  onCancel,
  onCreated,
  onPendingChange,
}: {
  name: string;
  onNameChange: (name: string) => void;
  onCancel: () => void;
  onCreated: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const t = useTranslations("fund.accounts.create");
  const tRoot = useTranslations();
  const [isSource, setIsSource] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);

  const onCreate = () => {
    setError(null);
    startTransition(async () => {
      const result = await createTokenAccountAction({
        name: name.trim(),
        kind: isSource ? "SOURCE" : "STANDARD",
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onCreated();
    });
  };

  return (
    <>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="account-name">{t("name")}</Label>
          <Input
            id="account-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t("namePlaceholder")}
            autoComplete="off"
          />
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="account-source"
            checked={isSource}
            onCheckedChange={(checked) => setIsSource(checked === true)}
            className="mt-0.5"
          />
          <div className="space-y-0.5">
            <Label htmlFor="account-source" className="font-normal">
              {t("sourceLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("sourceHint")}</p>
          </div>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          {tRoot("common.cancel")}
        </Button>
        <Button
          type="button"
          onClick={onCreate}
          disabled={pending || name.trim() === ""}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
          {t("confirm")}
        </Button>
      </DialogFooter>
    </>
  );
}
