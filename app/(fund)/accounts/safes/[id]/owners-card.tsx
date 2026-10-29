// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
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
import { proposeOwnerChangeAction } from "@/services/safe/admin-actions";
import {
  ProposeOwnerChangeSchema,
  type OwnerChangeInput,
} from "@/services/safe/schemas";

import { clampThreshold, sameAddress, shortAddress, thresholdLabel } from "../format";
import { OwnerAvatar } from "../owner-avatar";
import { useStepUp } from "@/components/reauth-dialog";
import { SafeAddress } from "../safe-address";
import { ThresholdStepper } from "../threshold-stepper";
import { CustodyNote } from "../safe-create-form";
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
};

export type MemberOption = {
  userId: string;
  name: string;
  email: string;
  signerAddress: string | null;
};

type Shared = {
  safeId: string;
  chainId: number;
  threshold: number;
  owners: OwnerRow[];
  hasPasskey: boolean;
};

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
  const shared = { safeId, chainId, threshold, owners, hasPasskey };

  // Staff not yet owning this Safe (by user or by their signer address).
  const addable = members.filter(
    (m) =>
      !owners.some(
        (o) =>
          (o.userId && o.userId === m.userId) ||
          sameAddress(o.address, m.signerAddress),
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
                    <Badge variant={external ? "info" : "default"}>
                      {t(`kind.${o.kind}`)}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {!external && o.email && <span>{o.email}</span>}
                    <SafeAddress address={o.address} />
                  </div>
                  {external && (
                    <p className="text-xs text-muted-foreground">{t("externalHint")}</p>
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

// One propose-owner-change round trip, shared by the three dialogs.
function useOwnerChange(safeId: string, hasPasskey: boolean) {
  const tRoot = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    executed: boolean;
    txHash: string | null;
  } | null>(null);
  const stepUp = useStepUp(hasPasskey);

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
      setResult({ executed: res.executed, txHash: res.txHash });
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
  members,
}: Shared & { members: MemberOption[] }) {
  const t = useTranslations("fund.safes.ownerChange");
  const flow = useOwnerChange(safeId, hasPasskey);
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
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name === m.email ? m.email : `${m.name} (${m.email})`}
                  </option>
                ))}
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
          <CustodyNote
            threshold={clampThreshold(newThreshold, total)}
            memberOwners={
              owners.filter((o) => o.kind === "MEMBER").length + (mode === "member" ? 1 : 0)
            }
          />
        </ChangeDialogBody>
        <ChangeDialogFooter
          flow={flow}
          onClose={() => onOpenChange(false)}
          onSubmit={onSubmit}
          disabled={!ready}
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
  owner,
  isYou,
}: Shared & { owner: OwnerRow; isYou: boolean }) {
  const t = useTranslations("fund.safes.ownerChange");
  const flow = useOwnerChange(safeId, hasPasskey);
  const remaining = owners.length - 1;
  const initial = clampThreshold(threshold, remaining);
  const [open, setOpen] = useState(false);
  const [newThreshold, setNewThreshold] = useState(initial);
  const mustDrop = threshold > remaining;

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
          <CustodyNote
            threshold={clampThreshold(newThreshold, remaining)}
            memberOwners={
              owners.filter((o) => o.kind === "MEMBER" && !sameAddress(o.address, owner.address)).length
            }
          />
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
          confirmLabel={t("removeConfirm")}
          destructive
        />
      </DialogContent>
    </Dialog>
  );
}

function ChangeThresholdDialog({ safeId, chainId, threshold, owners, hasPasskey }: Shared) {
  const t = useTranslations("fund.safes.ownerChange");
  const flow = useOwnerChange(safeId, hasPasskey);
  const [open, setOpen] = useState(false);
  const [newThreshold, setNewThreshold] = useState(threshold);
  const value = clampThreshold(newThreshold, owners.length);

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
          <CustodyNote
            threshold={value}
            memberOwners={owners.filter((o) => o.kind === "MEMBER").length}
          />
        </ChangeDialogBody>
        <ChangeDialogFooter
          flow={flow}
          onClose={() => onOpenChange(false)}
          onSubmit={() => flow.submit({ kind: "CHANGE_THRESHOLD", threshold: value })}
          disabled={value === threshold}
          confirmLabel={t("thresholdConfirm")}
        />
      </DialogContent>
    </Dialog>
  );
}
