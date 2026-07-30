// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
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
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { MemberStatus } from "@/services/db/generated/enums";
import { SUPPORTED_LOCALES, type SupportedLocale } from "@/services/i18n/config";
import {
  bulkDeleteMembersAction,
  bulkUpdateMembersAction,
  type BulkMemberUpdate,
} from "@/services/member/bulk-actions";
import { MEMBER_STATUSES } from "@/services/member/status-config";

import { useMemberSelection } from "./selection";

type Tier = { id: string; name: string };
type Property = "locale" | "status" | "tier";

const SELECT_CLASS =
  "h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring";

// Floating bar shown once at least one member is selected. Hosts the count, a
// clear button, and the "edit selected" dialog. On a successful apply it clears
// the selection and refreshes the (server-rendered) table.
export function BulkActionsBar({ tiers }: { tiers: Tier[] }) {
  const t = useTranslations("members.admin.bulk");
  const { selected, clear } = useMemberSelection();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const count = selected.size;

  if (count === 0) return null;

  return (
    <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-medium">{t("selected", { count })}</span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={clear}>
          {t("clearSelection")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
          {t("delete.trigger")}
        </Button>
        <Button size="sm" onClick={() => setEditOpen(true)}>
          {t("edit")}
        </Button>
      </div>
      <BulkEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        memberIds={[...selected]}
        tiers={tiers}
        onApplied={clear}
      />
      <BulkDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        memberIds={[...selected]}
        onApplied={clear}
      />
    </div>
  );
}

// Bulk-delete counterpart to the merchant/single-member delete flow (issue
// #35). Same eligibility rule as deleteMemberAction — no card, no financial
// history — enforced server-side; ineligible members in the selection are
// skipped and reported back rather than silently dropped.
function BulkDeleteDialog({
  open,
  onOpenChange,
  memberIds,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memberIds: string[];
  onApplied: () => void;
}) {
  const t = useTranslations("members.admin.bulk.delete");
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    deleted: number;
    skipped: number;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const finish = () => {
    onOpenChange(false);
    onApplied();
    router.refresh();
  };

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const res = await bulkDeleteMembersAction({ memberIds });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      if (res.skipped > 0) {
        setResult(res);
        return;
      }
      finish();
    });
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setError(null);
      setResult(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { count: memberIds.length })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <Alert variant={result.skipped > 0 ? "warning" : "default"}>
            <AlertDescription>
              {t("resultSkipped", {
                deleted: result.deleted,
                skipped: result.skipped,
              })}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>{t("irreversibleWarning")}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={finish}>{t("done")}</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={onConfirm}
                disabled={pending}
              >
                {pending ? t("deleting") : t("confirm")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkEditDialog({
  open,
  onOpenChange,
  memberIds,
  tiers,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memberIds: string[];
  tiers: Tier[];
  onApplied: () => void;
}) {
  const t = useTranslations("members.admin.bulk");
  const tLocale = useTranslations("locale");
  const tStatus = useTranslations("members.admin.status.values");
  const router = useRouter();

  const [property, setProperty] = useState<Property>("locale");
  const [localeValue, setLocaleValue] = useState<SupportedLocale>("fr");
  const [statusValue, setStatusValue] = useState<MemberStatus>("ACTIVE");
  // "" means "no tier" (clears the assignment).
  const [tierValue, setTierValue] = useState<string>("");

  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    updated: number;
    skipped: number;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const finish = () => {
    onOpenChange(false);
    onApplied();
    router.refresh();
  };

  const onSubmit = () => {
    setError(null);
    const update: BulkMemberUpdate =
      property === "locale"
        ? { field: "locale", value: localeValue }
        : property === "status"
          ? { field: "status", value: statusValue }
          : { field: "tier", value: tierValue === "" ? null : tierValue };

    startTransition(async () => {
      const res = await bulkUpdateMembersAction({ memberIds, update });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // Some status changes may have been skipped (invalid transition) — keep
      // the dialog open to report that. A clean run just closes.
      if (res.skipped > 0) {
        setResult(res);
        return;
      }
      finish();
    });
  };

  // Reset transient state whenever the dialog is (re)opened.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setError(null);
      setResult(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("dialogDescription", { count: memberIds.length })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <Alert variant={result.skipped > 0 ? "warning" : "default"}>
            <AlertDescription>
              {t("resultSkipped", {
                updated: result.updated,
                skipped: result.skipped,
              })}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bulk-property">{t("propertyLabel")}</Label>
              <select
                id="bulk-property"
                value={property}
                onChange={(e) => setProperty(e.target.value as Property)}
                className={SELECT_CLASS}
              >
                <option value="locale">{t("property.locale")}</option>
                <option value="status">{t("property.status")}</option>
                <option value="tier">{t("property.tier")}</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bulk-value">{t("valueLabel")}</Label>
              {property === "locale" && (
                <select
                  id="bulk-value"
                  value={localeValue}
                  onChange={(e) =>
                    setLocaleValue(e.target.value as SupportedLocale)
                  }
                  className={SELECT_CLASS}
                >
                  {SUPPORTED_LOCALES.map((loc) => (
                    <option key={loc} value={loc}>
                      {tLocale(loc)}
                    </option>
                  ))}
                </select>
              )}
              {property === "status" && (
                <select
                  id="bulk-value"
                  value={statusValue}
                  onChange={(e) =>
                    setStatusValue(e.target.value as MemberStatus)
                  }
                  className={SELECT_CLASS}
                >
                  {MEMBER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {tStatus(s)}
                    </option>
                  ))}
                </select>
              )}
              {property === "tier" && (
                <select
                  id="bulk-value"
                  value={tierValue}
                  onChange={(e) => setTierValue(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">{t("tierNone")}</option>
                  {tiers.map((tier) => (
                    <option key={tier.id} value={tier.id}>
                      {tier.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {property === "status" && (
              <p className="text-xs text-muted-foreground">
                {t("statusHint")}
              </p>
            )}
            {property === "status" && statusValue === "STOPPED" && (
              <p className="text-xs text-warning">{t("stoppedWarning")}</p>
            )}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={finish}>{t("done")}</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {t("cancel")}
              </Button>
              <Button onClick={onSubmit} disabled={pending}>
                {pending ? t("applying") : t("apply")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
