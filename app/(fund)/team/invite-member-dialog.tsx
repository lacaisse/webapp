// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Plus } from "lucide-react";
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
import { inviteFundMemberAction } from "@/services/fund-team/admin-actions";
import type { InvitableRole } from "@/services/fund-team/schema";

type FieldError = "email" | "role";

export function InviteMemberDialog({
  triggerLabel,
  // Roles the current admin is allowed to grant. OWNER → ["OWNER","ADMIN"],
  // ADMIN → ["ADMIN"].
  grantableRoles,
}: {
  triggerLabel: string;
  grantableRoles: InvitableRole[];
}) {
  const t = useTranslations("team.admin.invite");
  const roleLabel = useTranslations("team.roles");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>(
    grantableRoles[grantableRoles.length - 1] ?? "ADMIN",
  );
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<FieldError | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setEmail("");
    setRole(grantableRoles[grantableRoles.length - 1] ?? "ADMIN");
    setError(null);
    setErrorField(null);
  };

  const onSubmit = () => {
    setError(null);
    setErrorField(null);
    startTransition(async () => {
      const result = await inviteFundMemberAction({ email, role });
      if ("error" in result) {
        setError(result.error);
        setErrorField(result.field ?? null);
        return;
      }
      reset();
      setOpen(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="default">
            <Plus />
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="invite-email">
            {t("emailLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            aria-invalid={errorField === "email"}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-role">{t("roleLabel")}</Label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as InvitableRole)}
            className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {grantableRoles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
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
            {pending ? t("inviting") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
