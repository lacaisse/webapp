// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, CheckCircle2, Fingerprint, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSafeAction } from "@/services/safe/admin-actions";
import { ownerRuleViolation, type OwnerRuleViolation, type RuleOwner } from "@/services/safe/owner-rules";
import { ADDRESS, CreateSafeSchema } from "@/services/safe/schemas";

import { clampThreshold, serverCanSignAlone } from "./format";
import { OwnerAvatar } from "./owner-avatar";
import { RegisterSigningPasskeyButton } from "./signing-passkey-dialog";
import { ThresholdStepper } from "./threshold-stepper";

export type SafeMemberOption = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  // The member's signing passkey for this fund (the Safe owner address);
  // a member without one cannot be an owner yet.
  passkeyAddress: string | null;
  passkeyDeployed: boolean;
};

type ExternalRow = { key: number; address: string; label: string };

// Majority by default (1 of 1, 2 of 2, 2 of 3, 3 of 4…) until the admin
// touches the stepper.
const majority = (total: number) => Math.max(1, Math.floor(total / 2) + 1);

// The "several signatures" body of the create-account dialog: name, owners
// (team members + external addresses), threshold, and its own footer. It owns
// its state (the parent remounts it to reset) except the name, which the
// dialog keeps so it survives switching the security choice.
export function SafeCreateForm({
  name,
  onNameChange,
  members: initialMembers,
  currentUserId,
  hasPasskey,
  onCancel,
  onCreated,
  onPendingChange,
}: {
  name: string;
  onNameChange: (name: string) => void;
  members: SafeMemberOption[];
  currentUserId: string;
  hasPasskey: boolean; // login passkey → step-up dialog offers it
  onCancel: () => void;
  onCreated: (safeId: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const t = useTranslations("fund.safes.create");
  const tSafes = useTranslations("fund.safes");
  const tPasskey = useTranslations("fund.safes.passkey");
  const tRoot = useTranslations();

  // Local copy so a passkey the current user registers inline shows up
  // (and gets selected) without waiting for the page to re-render.
  const [members, setMembers] = useState(initialMembers);
  const canOwn = (m: SafeMemberOption) => Boolean(m.passkeyAddress) && m.passkeyDeployed;
  const [selected, setSelected] = useState<Set<string>>(() => {
    const self = members.find((m) => m.userId === currentUserId);
    return new Set(self && canOwn(self) ? [currentUserId] : []);
  });
  const [externals, setExternals] = useState<ExternalRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [threshold, setThreshold] = useState<number | null>(null); // null = auto
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  // Rows the admin started filling in count as owners; blank rows are ignored.
  const filledExternals = externals.filter(
    (r) => r.address.trim() !== "" || r.label.trim() !== "",
  );
  const total = selected.size + filledExternals.length;
  const effectiveThreshold = clampThreshold(threshold ?? majority(total), total);
  // Recovery rules (services/safe/owner-rules.ts): checked here for
  // immediate feedback, again by the server.
  const ruleOwners: RuleOwner[] = [
    ...[...selected].map((userId): RuleOwner => ({ kind: "PASSKEY", personId: userId })),
    ...filledExternals.map((): RuleOwner => ({ kind: "EXTERNAL", personId: null })),
  ];
  const violation = total > 0 ? ownerRuleViolation(ruleOwners, effectiveThreshold) : null;

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
      onCreated(result.safeId);
    });
  };

  return (
    <>
      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="safe-name">{t("name")}</Label>
          <Input
            id="safe-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
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
                const ready = canOwn(m);
                const isMe = m.userId === currentUserId;
                return (
                  <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      id={id}
                      checked={selected.has(m.userId)}
                      disabled={!ready}
                      onCheckedChange={(c) => toggleMember(m.userId, c === true)}
                    />
                    <OwnerAvatar name={m.name} image={m.image} className="size-7" />
                    <Label
                      htmlFor={id}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0 font-normal"
                    >
                      <span className="flex items-center gap-1.5 text-sm">
                        {m.name}
                        {isMe && <Badge variant="outline">{tSafes("you")}</Badge>}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {m.email}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Fingerprint className="size-3" />
                        {ready
                          ? tPasskey("memberReady")
                          : m.passkeyAddress
                            ? tPasskey("memberNotDeployed")
                            : tPasskey("memberMissing")}
                      </span>
                    </Label>
                    {isMe && !m.passkeyAddress && (
                      <RegisterSigningPasskeyButton
                        replace={false}
                        hasPasskey={hasPasskey}
                        size="xs"
                        variant="outline"
                        onRegistered={(pk) => {
                          setMembers((prev) =>
                            prev.map((x) =>
                              x.userId === currentUserId
                                ? { ...x, passkeyAddress: pk.address, passkeyDeployed: pk.deployed }
                                : x,
                            ),
                          );
                          if (pk.deployed) toggleMember(currentUserId, true);
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("externalOwners")}</legend>
          <p className="text-xs text-muted-foreground">{t("externalOwnersHint")}</p>
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

        {total > 0 && <RecoveryRulesNote violation={violation} teamOwners={selected.size} />}

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
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          {tRoot("common.cancel")}
        </Button>
        <Button
          type="button"
          onClick={onCreate}
          disabled={pending || name.trim() === "" || total === 0 || violation !== null}
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

// The recovery rules for Safes with team owners (owner-rules.ts), as the
// dialogs explain them: a violation blocks the submit with its reason, a
// passing set with team owners gets the reminder of why the rules exist.
export function RecoveryRulesNote({
  violation,
  teamOwners,
}: {
  violation: OwnerRuleViolation | null;
  teamOwners: number;
}) {
  const t = useTranslations("fund.safes.rules");
  if (violation) {
    return (
      <Alert variant="warning">
        <AlertTriangle className="size-4" />
        <AlertDescription>{t(violation)}</AlertDescription>
      </Alert>
    );
  }
  if (teamOwners === 0) return null;
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
      {t("why")}
    </p>
  );
}

// Who really controls the Safe at this threshold (review S3): LEGACY team
// keys (server-held, MEMBER owners) sit with La Caisse, so a threshold those
// keys alone can meet is not independent of the server. Only shown while a
// Safe still has such owners (the migration removes them).
export function CustodyNote({
  threshold,
  memberOwners,
}: {
  threshold: number;
  memberOwners: number;
}) {
  const t = useTranslations("fund.safes.custody");
  const shared = serverCanSignAlone(threshold, memberOwners);
  return (
    <Alert variant={shared ? "warning" : "default"}>
      <AlertDescription>
        {shared
          ? t("shared", { threshold, members: memberOwners })
          : t("independent")}
      </AlertDescription>
    </Alert>
  );
}
