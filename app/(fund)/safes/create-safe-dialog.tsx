// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { createSafeAction } from "@/services/safe/admin-actions";
import { ADDRESS, CreateSafeSchema } from "@/services/safe/schemas";

import { clampThreshold } from "./format";
import { OwnerAvatar } from "./owner-avatar";
import { ThresholdStepper } from "./threshold-stepper";

type MemberOption = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
};

type ExternalRow = { key: number; address: string; label: string };

// Majority by default (1 of 1, 2 of 2, 2 of 3, 3 of 4…) until the admin
// touches the stepper.
const majority = (total: number) => Math.max(1, Math.floor(total / 2) + 1);

export function CreateSafeDialog({
  members,
  currentUserId,
}: {
  members: MemberOption[];
  currentUserId: string;
}) {
  const t = useTranslations("fund.safes.create");
  const tSafes = useTranslations("fund.safes");
  const tRoot = useTranslations();
  const router = useRouter();

  const initialSelected = () =>
    new Set(members.some((m) => m.userId === currentUserId) ? [currentUserId] : []);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [externals, setExternals] = useState<ExternalRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [threshold, setThreshold] = useState<number | null>(null); // null = auto
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Rows the admin started filling in count as owners; blank rows are ignored.
  const filledExternals = externals.filter(
    (r) => r.address.trim() !== "" || r.label.trim() !== "",
  );
  const total = selected.size + filledExternals.length;
  const effectiveThreshold = clampThreshold(threshold ?? majority(total), total);

  function reset() {
    setName("");
    setSelected(initialSelected());
    setExternals([]);
    setThreshold(null);
    setError(null);
  }

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) reset();
  }

  function toggleMember(userId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  function addExternal() {
    setExternals((prev) => [...prev, { key: nextKey, address: "", label: "" }]);
    setNextKey((k) => k + 1);
  }

  function updateExternal(key: number, patch: Partial<ExternalRow>) {
    setExternals((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeExternal(key: number) {
    setExternals((prev) => prev.filter((r) => r.key !== key));
  }

  const onCreate = () => {
    setError(null);
    const addresses = filledExternals.map((r) => r.address.trim().toLowerCase());
    if (new Set(addresses).size !== addresses.length) {
      setError(tRoot("fund.safes.errors.duplicateOwner"));
      return;
    }
    const parsed = CreateSafeSchema.safeParse({
      name,
      memberUserIds: members
        .filter((m) => selected.has(m.userId))
        .map((m) => m.userId),
      externalOwners: filledExternals.map((r) => ({
        address: r.address,
        label: r.label,
      })),
      threshold: effectiveThreshold,
    });
    if (!parsed.success) {
      setError(tRoot(parsed.error.issues[0]!.message as never));
      return;
    }
    startTransition(async () => {
      const result = await createSafeAction(parsed.data);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      reset();
      router.push(`/safes/${result.safeId}`);
    });
  };

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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="safe-name">{t("name")}</Label>
            <Input
              id="safe-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              autoComplete="off"
              maxLength={60}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("teamOwners")}</legend>
            <p className="text-xs text-muted-foreground">{t("teamOwnersHint")}</p>
            {members.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noMembers")}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg ring-1 ring-foreground/10">
                {members.map((m) => {
                  const id = `safe-member-${m.userId}`;
                  return (
                    <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        id={id}
                        checked={selected.has(m.userId)}
                        onCheckedChange={(c) => toggleMember(m.userId, c === true)}
                      />
                      <OwnerAvatar name={m.name} image={m.image} className="size-7" />
                      <Label
                        htmlFor={id}
                        className="flex min-w-0 flex-1 flex-col items-start gap-0 font-normal"
                      >
                        <span className="flex items-center gap-1.5 text-sm">
                          {m.name}
                          {m.userId === currentUserId && (
                            <Badge variant="outline">{tSafes("you")}</Badge>
                          )}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {m.email}
                        </span>
                      </Label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("externalOwners")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("externalOwnersHint")}
            </p>
            {externals.map((r, i) => {
              const invalid =
                r.address.trim() !== "" && !ADDRESS.safeParse(r.address).success;
              return (
                <div key={r.key} className="flex items-start gap-2">
                  <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-[1fr_10rem]">
                    <Input
                      aria-label={t("externalAddress", { index: i + 1 })}
                      value={r.address}
                      onChange={(e) => updateExternal(r.key, { address: e.target.value })}
                      placeholder="0x…"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={invalid || undefined}
                      className="font-mono text-xs"
                    />
                    <Input
                      aria-label={t("externalLabel", { index: i + 1 })}
                      value={r.label}
                      onChange={(e) => updateExternal(r.key, { label: e.target.value })}
                      placeholder={t("externalLabelPlaceholder")}
                      autoComplete="off"
                      maxLength={60}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("removeExternal")}
                    onClick={() => removeExternal(r.key)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
            <Button type="button" variant="outline" size="xs" onClick={addExternal}>
              <Plus />
              {t("addExternal")}
            </Button>
          </fieldset>

          {total > 0 && (
            <ThresholdStepper
              id="safe-threshold"
              value={effectiveThreshold}
              total={total}
              onChange={setThreshold}
              disabled={pending}
            />
          )}

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            {t("deployHint")}
          </p>

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
            onClick={onCreate}
            disabled={pending || name.trim() === "" || total === 0}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
