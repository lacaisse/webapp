// SPDX-License-Identifier: AGPL-3.0-or-later
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
import {
  changeFundMemberRoleAction,
  removeFundMemberAction,
} from "@/services/fund-team/admin-actions";
import type { InvitableRole } from "@/services/fund-team/schema";

// Staff-row controls: a role picker (grantable roles only) and a confirmed
// remove. All rules are re-checked server-side; this just hides what the
// actor isn't allowed to do.
export function MemberRowActions({
  membershipId,
  memberName,
  currentRole,
  grantableRoles,
  canModify,
  canRemove,
}: {
  membershipId: string;
  memberName: string;
  currentRole: string;
  grantableRoles: InvitableRole[];
  canModify: boolean;
  canRemove: boolean;
}) {
  const t = useTranslations("team.actions");
  const roleLabel = useTranslations("team.roles");
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Show the current role in the dropdown even if it isn't grantable (e.g. a
  // legacy VIEWER, or an OWNER an ADMIN can't reassign).
  const options = grantableRoles.includes(currentRole as InvitableRole)
    ? grantableRoles
    : [currentRole as InvitableRole, ...grantableRoles];

  const onRoleChange = (role: InvitableRole) => {
    if (role === currentRole) return;
    setError(null);
    startTransition(async () => {
      const result = await changeFundMemberRoleAction({ membershipId, role });
      if ("error" in result) setError(result.error);
    });
  };

  const onRemove = () => {
    setError(null);
    startTransition(async () => {
      const result = await removeFundMemberAction({ membershipId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setConfirmOpen(false);
    });
  };

  return (
    <div className="inline-flex items-center justify-end gap-2">
      {error && (
        <Alert variant="destructive" className="py-1">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {canModify ? (
        <select
          aria-label={t("roleLabel")}
          value={currentRole}
          disabled={pending}
          onChange={(e) => onRoleChange(e.target.value as InvitableRole)}
          className="h-8 rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {options.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-sm text-muted-foreground">
          {roleLabel(currentRole as never)}
        </span>
      )}

      {canRemove && (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger
            render={
              <Button variant="ghost" size="sm">
                {t("remove")}
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("removeTitle")}</DialogTitle>
              <DialogDescription>
                {t("removeDescription", { memberName })}
              </DialogDescription>
            </DialogHeader>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmOpen(false)}
                disabled={pending}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={onRemove}
                disabled={pending}
              >
                {pending ? t("removing") : t("confirmRemove")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
