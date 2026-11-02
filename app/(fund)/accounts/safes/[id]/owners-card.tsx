// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  Info,
  Loader2,
  SlidersHorizontal,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { FundSafeOwnerKind } from "@/services/db/generated/enums";
import type { SigningPasskeyHandle } from "@/services/safe/action-types";
import { proposeOwnerChangeAction } from "@/services/safe/admin-actions";
import { ownerRuleViolation, type RuleOwner } from "@/services/safe/owner-rules";
import {
  ProposeOwnerChangeSchema,
  type OwnerChangeInput,
} from "@/services/safe/schemas";

import { clampThreshold, sameAddress, shortAddress, thresholdLabel } from "../format";
import { OwnerAvatar } from "../owner-avatar";
import { useStepUp } from "@/components/reauth-dialog";
import { useProposeAndSign, type ProposalOutcome } from "../passkey-hooks";
import { SafeAddress } from "../safe-address";
import { ThresholdStepper } from "../threshold-stepper";
import { CustodyNote, RecoveryRulesNote } from "../safe-create-form";
import { ProposalResult } from "./proposal-result";

export type OwnerRow = {
  address: string;
  kind: FundSafeOwnerKind;
  label: string | null;
  displayName: string;
  userId: string | null;
  email: string | null;
  image: string | null;
  isFormerMember: boolean;
  backedUp: boolean | null; // PASSKEY: synced to a backup (last ceremony's flags)
  passkeyReplaced: boolean; // PASSKEY: credential replaced, swap pending
};

export type MemberOption = {
  userId: string;
  name: string;
  email: string;
  signerAddress: string | null; // legacy server key, if any
  passkeyAddress: string | null;
  passkeyDeployed: boolean;
};

type Shared = {
  safeId: string;
  chainId: number;
  threshold: number;
  owners: OwnerRow[];
  hasPasskey: boolean;
  me: SigningPasskeyHandle | null; // the viewer's signing passkey
};

// The recovery rules see each owner as who holds its key.
function ruleOwnerOf(o: OwnerRow): RuleOwner {
  return o.kind === "EXTERNAL"
    ? { kind: "EXTERNAL", personId: null }
    : { kind: o.kind, personId: o.userId };
}
const legacyCount = (owners: OwnerRow[]) => owners.filter((o) => o.kind === "MEMBER").length;

const SELECT_CLASS =
  "h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring";

// The Safe's current owners and the three owner-set changes. Every change is
// itself a Safe transaction: it shows up in "Pending" and needs the CURRENT
// threshold of signatures before it takes effect.
export function OwnersCard({
  safeId,
  chainId,
  threshold,
  owners,
  hasPasskey,
  me,
  members,
  currentUserId,
  canPropose,
}: Shared & {
  members: MemberOption[];
  currentUserId: string;
  canPropose: boolean;
}) {
  const t = useTranslations("fund.safes.owners");
  const tSafes = useTranslations("fund.safes");
  const tPasskey = useTranslations("fund.safes.passkey");
  const shared = { safeId, chainId, threshold, owners, hasPasskey, me };

  // Staff not yet owning this Safe (by user, or by either of their addresses).
  const addable = members.filter(
    (m) =>
      !owners.some(
        (o) =>
          (o.userId && o.userId === m.userId) ||
          sameAddress(o.address, m.signerAddress) ||
          sameAddress(o.address, m.passkeyAddress),
      ),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>
          {t("description", {
            threshold: thresholdLabel(threshold, owners.length, tSafes),
          })}
        </CardDescription>
        {canPropose && (
          <CardAction className="flex flex-wrap gap-2">
            <ChangeThresholdDialog {...shared} />
            <AddOwnerDialog {...shared} members={addable} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {owners.map((o) => {
            const external = o.kind === "EXTERNAL";
            const isYou = Boolean(o.userId && o.userId === currentUserId);
            return (
              <li
                key={o.address}
                className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <OwnerAvatar name={o.displayName} image={o.image} external={external} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {o.displayName}
                    {isYou && <Badge variant="outline">{tSafes("you")}</Badge>}
                    <Badge variant={external ? "info" : o.kind === "PASSKEY" ? "success" : "warning"}>
                      {o.kind === "PASSKEY" && <Fingerprint className="size-3" />}
                      {t(`kind.${o.kind}`)}
                    </Badge>
                    {o.kind === "PASSKEY" && o.backedUp !== null && (
                      <Badge variant={o.backedUp ? "default" : "warning"}>
                        {o.backedUp ? (
                          <CheckCircle2 className="size-3" />
                        ) : (
                          <AlertTriangle className="size-3" />
                        )}
                        {o.backedUp ? tPasskey("backedUp") : tPasskey("deviceOnly")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {!external && o.email && <span>{o.email}</span>}
                    <SafeAddress address={o.address} />
                  </div>
                  {external && (
                    <p className="text-xs text-muted-foreground">{t("externalHint")}</p>
                  )}
                  {o.kind === "MEMBER" && (
                    <p className="flex items-center gap-1 text-xs text-warning">
                      <Info className="size-3" />
                      {t("serverKeyHint")}
                    </p>
                  )}
                  {o.kind === "PASSKEY" && o.passkeyReplaced && (
                    <p className="flex items-center gap-1 text-xs text-warning">
                      <Info className="size-3" />
                      {t("replacedPasskeyHint")}
                    </p>
                  )}
                  {o.kind === "PASSKEY" && o.backedUp === false && !o.passkeyReplaced && (
                    <p className="text-xs text-muted-foreground">{tPasskey("deviceOnlyOwnerHint")}</p>
                  )}
                  {o.isFormerMember && (
                    <p className="flex items-center gap-1 text-xs text-warning">
                      <Info className="size-3" />
                      {t("formerMember")}
                    </p>
                  )}
                </div>
                {canPropose && owners.length > 1 && (
                  <RemoveOwnerDialog {...shared} owner={o} isYou={isYou} />
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// One propose-owner-change round trip, shared by the three dialogs. A
// passkey owner's proposal is followed by their signing ceremony.
function useOwnerChange(safeId: string, hasPasskey: boolean, me: SigningPasskeyHandle | null) {
  const tRoot = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposalOutcome | null>(null);
  const stepUp = useStepUp(hasPasskey);
  const { finish } = useProposeAndSign(safeId, me);

  function submit(change: OwnerChangeInput) {
    setError(null);
    const parsed = ProposeOwnerChangeSchema.safeParse({ safeId, change });
    if (!parsed.success) {
      setError(tRoot(parsed.error.issues[0]!.message as never));
      return;
    }
    startTransition(async () => {
      const res = await proposeOwnerChangeAction(parsed.data);
      // Not fresh enough: confirm identity, then the same change again.
      if (stepUp.check(res, () => submit(change))) return;
      // Refresh on errors too: the proposal may exist and be marked FAILED.
      router.refresh();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const outcome = await finish(res);
      router.refresh();
      setResult(outcome);
    });
  }

  function reset() {
    setError(null);
    setResult(null);
  }

  return { pending: pending || stepUp.pending, error, result, submit, reset, stepUp };
}

// Footer + body pieces every owner dialog shares.
function ChangeDialogBody({
  chainId,
  threshold,
  flow,
  children,
}: {
  chainId: number;
  threshold: number;
  flow: ReturnType<typeof useOwnerChange>;
  children: React.ReactNode;
}) {
  const t = useTranslations("fund.safes.ownerChange");
  if (flow.result) {
    return (
      <ProposalResult
        chainId={chainId}
        executed={flow.result.executed}
        txHash={flow.result.txHash}
        threshold={threshold}
        unsigned={flow.result.unsigned}
        error={flow.result.error}
      />
    );
  }
  return (
    <div className="space-y-4">
      {children}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        {t("needsSignatures", { threshold })}
      </p>
      {flow.error && (
        <Alert variant="destructive">
          <AlertDescription>{flow.error}</AlertDescription>
        </Alert>
      )}
      {flow.stepUp.dialog}
    </div>
  );
}

function ChangeDialogFooter({
  flow,
  onClose,
  onSubmit,
  disabled,
  confirmLabel,
  destructive,
}: {
  flow: ReturnType<typeof useOwnerChange>;
  onClose: () => void;
  onSubmit: () => void;
  disabled?: boolean;
  confirmLabel: string;
  destructive?: boolean;
}) {
  const tRoot = useTranslations();
  return (
    <DialogFooter>
      {flow.result ? (
        <Button type="button" variant="ghost" onClick={onClose}>
          {tRoot("common.close")}
        </Button>
      ) : (
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={flow.pending}>
            {tRoot("common.cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={onSubmit}
            disabled={flow.pending || disabled}
          >
            {flow.pending && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </>
      )}
    </DialogFooter>
  );
}

function AddOwnerDialog({
  safeId,
  chainId,
  threshold,
  owners,
  hasPasskey,
  me,
  members,
}: Shared & { members: MemberOption[] }) {
  const t = useTranslations("fund.safes.ownerChange");
  const tPasskey = useTranslations("fund.safes.passkey");
  const flow = useOwnerChange(safeId, hasPasskey, me);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"member" | "external">(
    members.length > 0 ? "member" : "external",
  );
  const [memberUserId, setMemberUserId] = useState("");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [newThreshold, setNewThreshold] = useState(threshold);
  const total = owners.length + 1;

  function onOpenChange(next: boolean) {
    if (flow.pending) return;
    setOpen(next);
    if (!next) {
      setMode(members.length > 0 ? "member" : "external");
      setMemberUserId("");
      setAddress("");
      setLabel("");
      setNewThreshold(threshold);
      flow.reset();
    }
  }

  const onSubmit = () => {
    const thresholdValue = clampThreshold(newThreshold, total);
    if (mode === "member") {
      flow.submit({ kind: "ADD_OWNER", threshold: thresholdValue, memberUserId });
    } else {
      flow.submit({
        kind: "ADD_OWNER",
        threshold: thresholdValue,
        address,
        label: label.trim() === "" ? undefined : label,
      });
    }
  };

  const ready = mode === "member" ? memberUserId !== "" : address.trim() !== "";
  const pickedMember = members.find((m) => m.userId === memberUserId);
  const newRule: RuleOwner | null =
    mode === "member"
      ? pickedMember
        ? { kind: "PASSKEY", personId: pickedMember.userId }
        : null
      : address.trim() !== ""
        ? { kind: "EXTERNAL", personId: null }
        : null;
  const violation = newRule
    ? ownerRuleViolation([...owners.map(ruleOwnerOf), newRule], clampThreshold(newThreshold, total))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <UserPlus className="size-4" />
            {t("addTrigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addDescription")}</DialogDescription>
        </DialogHeader>
        <ChangeDialogBody chainId={chainId} threshold={threshold} flow={flow}>
          <div
            role="radiogroup"
            aria-label={t("addTitle")}
            className="inline-flex rounded-lg bg-muted p-0.5"
          >
            {(["member", "external"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                disabled={m === "member" && members.length === 0}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                  mode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(m === "member" ? "modeMember" : "modeExternal")}
              </button>
            ))}
          </div>

          {mode === "member" ? (
            <div className="space-y-2">
              <Label htmlFor={`add-owner-member-${safeId}`}>{t("member")}</Label>
              <select
                id={`add-owner-member-${safeId}`}
                value={memberUserId}
                onChange={(e) => setMemberUserId(e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">{t("pickMember")}</option>
                {members.map((m) => {
                  const ok = Boolean(m.passkeyAddress) && m.passkeyDeployed;
                  return (
                    <option key={m.userId} value={m.userId} disabled={!ok}>
                      {m.name === m.email ? m.email : `${m.name} (${m.email})`}
                      {ok ? "" : ` — ${tPasskey("memberMissing")}`}
                    </option>
                  );
                })}
              </select>
              <p className="text-xs text-muted-foreground">{t("memberHint")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`add-owner-address-${safeId}`}>{t("address")}</Label>
              <Input
                id={`add-owner-address-${safeId}`}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Label htmlFor={`add-owner-label-${safeId}`}>{t("label")}</Label>
              <Input
                id={`add-owner-label-${safeId}`}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("labelPlaceholder")}
                autoComplete="off"
                maxLength={60}
              />
              <p className="text-xs text-muted-foreground">{t("externalHint")}</p>
            </div>
          )}

          <ThresholdStepper
            id={`add-owner-threshold-${safeId}`}
            value={newThreshold}
            total={total}
            onChange={setNewThreshold}
            disabled={flow.pending}
          />
          <RecoveryRulesNote violation={violation} teamOwners={legacyCount(owners) + owners.filter((o) => o.kind === "PASSKEY").length + (mode === "member" ? 1 : 0)} />
          {legacyCount(owners) > 0 && (
            <CustodyNote threshold={clampThreshold(newThreshold, total)} memberOwners={legacyCount(owners)} />
          )}
        </ChangeDialogBody>
        <ChangeDialogFooter
          flow={flow}
          onClose={() => onOpenChange(false)}
          onSubmit={onSubmit}
          disabled={!ready || violation !== null}
          confirmLabel={t("addConfirm")}
        />
      </DialogContent>
    </Dialog>
  );
}

function RemoveOwnerDialog({
  safeId,
  chainId,
  threshold,
  owners,
  hasPasskey,
  me,
  owner,
  isYou,
}: Shared & { owner: OwnerRow; isYou: boolean }) {
  const t = useTranslations("fund.safes.ownerChange");
  const flow = useOwnerChange(safeId, hasPasskey, me);
  const remaining = owners.length - 1;
  const initial = clampThreshold(threshold, remaining);
  const [open, setOpen] = useState(false);
  const [newThreshold, setNewThreshold] = useState(initial);
  const mustDrop = threshold > remaining;
  const rest = owners.filter((o) => !sameAddress(o.address, owner.address));
  const violation = ownerRuleViolation(rest.map(ruleOwnerOf), clampThreshold(newThreshold, remaining));

  function onOpenChange(next: boolean) {
    if (flow.pending) return;
    setOpen(next);
    if (!next) {
      setNewThreshold(initial);
      flow.reset();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
          >
            <UserMinus className="size-4" />
            {t("removeTrigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("removeTitle", { owner: owner.displayName })}</DialogTitle>
          <DialogDescription>
            {t("removeDescription", { address: shortAddress(owner.address) })}
          </DialogDescription>
        </DialogHeader>
        <ChangeDialogBody chainId={chainId} threshold={threshold} flow={flow}>
          {mustDrop && (
            <Alert variant="warning">
              <AlertDescription>
                {t("thresholdMustDrop", { threshold: remaining, remaining })}
              </AlertDescription>
            </Alert>
          )}
          {isYou && (
            <Alert variant="warning">
              <AlertDescription>{t("removeSelf")}</AlertDescription>
            </Alert>
          )}
          <ThresholdStepper
            id={`remove-owner-threshold-${safeId}-${owner.address}`}
            value={newThreshold}
            total={remaining}
            onChange={setNewThreshold}
            disabled={flow.pending}
          />
          <RecoveryRulesNote violation={violation} teamOwners={rest.filter((o) => o.kind !== "EXTERNAL").length} />
          {legacyCount(rest) > 0 && (
            <CustodyNote threshold={clampThreshold(newThreshold, remaining)} memberOwners={legacyCount(rest)} />
          )}
        </ChangeDialogBody>
        <ChangeDialogFooter
          flow={flow}
          onClose={() => onOpenChange(false)}
          onSubmit={() =>
            flow.submit({
              kind: "REMOVE_OWNER",
              address: owner.address,
              threshold: clampThreshold(newThreshold, remaining),
            })
          }
          disabled={violation !== null}
          confirmLabel={t("removeConfirm")}
          destructive
        />
      </DialogContent>
    </Dialog>
  );
}

function ChangeThresholdDialog({ safeId, chainId, threshold, owners, hasPasskey, me }: Shared) {
  const t = useTranslations("fund.safes.ownerChange");
  const flow = useOwnerChange(safeId, hasPasskey, me);
  const [open, setOpen] = useState(false);
  const [newThreshold, setNewThreshold] = useState(threshold);
  const value = clampThreshold(newThreshold, owners.length);
  const violation = ownerRuleViolation(owners.map(ruleOwnerOf), value);

  function onOpenChange(next: boolean) {
    if (flow.pending) return;
    setOpen(next);
    if (!next) {
      setNewThreshold(threshold);
      flow.reset();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <SlidersHorizontal className="size-4" />
            {t("thresholdTrigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("thresholdTitle")}</DialogTitle>
          <DialogDescription>{t("thresholdDescription")}</DialogDescription>
        </DialogHeader>
        <ChangeDialogBody chainId={chainId} threshold={threshold} flow={flow}>
          <ThresholdStepper
            id={`change-threshold-${safeId}`}
            value={value}
            total={owners.length}
            onChange={setNewThreshold}
            disabled={flow.pending}
          />
          <RecoveryRulesNote violation={violation} teamOwners={owners.filter((o) => o.kind !== "EXTERNAL").length} />
          {legacyCount(owners) > 0 && (
            <CustodyNote threshold={value} memberOwners={legacyCount(owners)} />
          )}
        </ChangeDialogBody>
        <ChangeDialogFooter
          flow={flow}
          onClose={() => onOpenChange(false)}
          onSubmit={() => flow.submit({ kind: "CHANGE_THRESHOLD", threshold: value })}
          disabled={value === threshold || violation !== null}
          confirmLabel={t("thresholdConfirm")}
        />
      </DialogContent>
    </Dialog>
  );
}
