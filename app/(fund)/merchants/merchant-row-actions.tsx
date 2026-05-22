// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Mail,
  Trash2,
  Unplug,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import {
  type AffectedPlace,
  approveMerchantAction,
  archiveMerchantAction,
  deleteMerchantAction,
  disconnectMerchantAction,
  inviteMerchantAction,
  previewDisconnectMerchantAction,
  reconsiderMerchantAction,
  rejectMerchantAction,
  restoreMerchantAction,
} from "@/services/merchant/admin-actions";

// Approve / Reject buttons + dialogs. Approve has an optional note; Reject
// requires a reason (visible to the merchant in the email). Both dialogs
// confirm before firing the server action — approvals send emails which
// are awkward to walk back.

export function MerchantRowActions({
  merchantId,
  merchantName,
  merchantEmail,
  emailVerified,
  status,
  connected,
  invitePending,
}: {
  merchantId: string;
  merchantName: string;
  // Used to pre-fill the invite modal. Null when not collected yet —
  // the modal lets the admin enter one.
  merchantEmail: string | null;
  emailVerified: boolean;
  status: "PENDING" | "ACTIVE" | "INACTIVE" | "REJECTED";
  // True iff Merchant.citizenPayBusinessId is set. Connection is the only
  // gate for showing Disconnect — even an INACTIVE merchant can have a
  // live CP business that the treasury should be able to tear down.
  connected: boolean;
  // True iff there's an unexpired citizenPayInviteToken on the merchant.
  // Switches the Invite button to a "Re-invite" / "Pending" affordance.
  invitePending: boolean;
}) {
  if (status === "REJECTED") {
    return <ReconsiderButton merchantId={merchantId} />;
  }
  if (status === "PENDING") {
    return (
      <div className="inline-flex items-center gap-2">
        <ApproveButton
          merchantId={merchantId}
          merchantName={merchantName}
          emailVerified={emailVerified}
        />
        <RejectButton merchantId={merchantId} merchantName={merchantName} />
      </div>
    );
  }
  if (connected) {
    return (
      <DisconnectButton
        merchantId={merchantId}
        merchantName={merchantName}
      />
    );
  }
  // ACTIVE merchant that hasn't been connected on Citizen Pay yet.
  // Invite-by-email is the connection path; Archive is the way to hide a
  // merchant who'll never connect (closed, duplicate, etc.).
  if (status === "ACTIVE") {
    return (
      <div className="inline-flex items-center gap-2">
        <InviteButton
          merchantId={merchantId}
          merchantName={merchantName}
          merchantEmail={merchantEmail}
          invitePending={invitePending}
        />
        <ArchiveButton
          merchantId={merchantId}
          merchantName={merchantName}
        />
      </div>
    );
  }
  // Archived merchants — restore brings them back to ACTIVE; delete is
  // permanent (with a confirmation modal).
  if (status === "INACTIVE") {
    return (
      <div className="inline-flex items-center gap-2">
        <RestoreButton merchantId={merchantId} />
        <DeleteButton
          merchantId={merchantId}
          merchantName={merchantName}
        />
      </div>
    );
  }
  return null;
}

function ArchiveButton({
  merchantId,
  merchantName,
}: {
  merchantId: string;
  merchantName: string;
}) {
  const t = useTranslations("merchants.admin.archive");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await archiveMerchantAction({ merchantId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Archive className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { merchantName })}
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
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? t("archiving") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreButton({ merchantId }: { merchantId: string }) {
  const t = useTranslations("merchants.admin.archive");
  const [pending, startTransition] = useTransition();
  const onClick = () => {
    startTransition(async () => {
      await restoreMerchantAction({ merchantId });
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      <ArchiveRestore className="size-4" />
      {pending ? t("restoring") : t("restore")}
    </Button>
  );
}

function DeleteButton({
  merchantId,
  merchantName,
}: {
  merchantId: string;
  merchantName: string;
}) {
  const t = useTranslations("merchants.admin.delete");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteMerchantAction({ merchantId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Trash2 className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title", { merchantName })}</DialogTitle>
          <DialogDescription>
            {t("description", { merchantName })}
          </DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertDescription>{t("irreversibleWarning")}</AlertDescription>
        </Alert>
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
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? t("deleting") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReconsiderButton({ merchantId }: { merchantId: string }) {
  const t = useTranslations("merchants.admin.review");
  const [pending, startTransition] = useTransition();
  const onClick = () => {
    startTransition(async () => {
      await reconsiderMerchantAction({ merchantId });
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      {pending ? t("reconsidering") : t("reconsider")}
    </Button>
  );
}

function ApproveButton({
  merchantId,
  merchantName,
  emailVerified,
}: {
  merchantId: string;
  merchantName: string;
  emailVerified: boolean;
}) {
  const t = useTranslations("merchants.admin.review");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onApprove = () => {
    setError(null);
    startTransition(async () => {
      const result = await approveMerchantAction({ merchantId, note });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setNote("");
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="default" size="sm" />}>
        {t("approve")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("approveTitle")}</DialogTitle>
          <DialogDescription>
            {t("approveDescription", { merchantName })}
          </DialogDescription>
        </DialogHeader>
        {!emailVerified && (
          <Alert variant="warning">
            <AlertDescription>{t("approveUnverifiedWarning")}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor={`approve-note-${merchantId}`}>
            {t("approveNoteLabel")}
          </Label>
          <textarea
            id={`approve-note-${merchantId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("approveNotePlaceholder")}
            className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
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
          <Button onClick={onApprove} disabled={pending}>
            {pending ? t("approving") : t("approveConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteButton({
  merchantId,
  merchantName,
  merchantEmail,
  invitePending,
}: {
  merchantId: string;
  merchantName: string;
  merchantEmail: string | null;
  invitePending: boolean;
}) {
  const t = useTranslations("merchants.admin.invite");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(merchantEmail ?? "");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "sent"; inviteUrl: string; emailSent: boolean }
  >({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  function onOpenChange(next: boolean) {
    if (!next && pending) return;
    setOpen(next);
    setError(null);
    setEmailError(null);
    if (!next) {
      setResult({ kind: "idle" });
      setEmail(merchantEmail ?? "");
      setCopied(false);
    }
  }

  function onConfirm() {
    setError(null);
    setEmailError(null);
    startTransition(async () => {
      const res = await inviteMerchantAction({ merchantId, email });
      if ("error" in res) {
        if (res.field === "email") setEmailError(res.error);
        else setError(res.error);
        return;
      }
      setResult({
        kind: "sent",
        inviteUrl: res.inviteUrl,
        emailSent: res.emailSent,
      });
    });
  }

  async function onCopy() {
    if (result.kind !== "sent") return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context, permissions). Fall
      // back to a manual select — the input is already visible.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Mail className="size-4" />
            {invitePending ? t("triggerPending") : t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { merchantName })}
          </DialogDescription>
        </DialogHeader>

        {result.kind === "idle" && (
          <div className="space-y-2">
            <Label htmlFor={`invite-email-${merchantId}`}>
              {t("emailLabel")}
            </Label>
            <Input
              id={`invite-email-${merchantId}`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("emailPlaceholder")}
              autoFocus={!merchantEmail}
            />
            {emailError && (
              <p className="text-xs text-destructive">{emailError}</p>
            )}
            {invitePending && (
              <Alert variant="warning">
                <AlertDescription>{t("reissueNote")}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {result.kind === "sent" && (
          <div className="space-y-3">
            <Alert>
              <AlertDescription>
                {result.emailSent ? t("sentOk") : t("sentFallback")}
              </AlertDescription>
            </Alert>
            <div className="space-y-2">
              <Label htmlFor={`invite-url-${merchantId}`}>
                {t("urlLabel")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id={`invite-url-${merchantId}`}
                  readOnly
                  value={result.inviteUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={onCopy}
                  aria-label={t("copy")}
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          {result.kind === "idle" ? (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {t("cancel")}
              </Button>
              <Button onClick={onConfirm} disabled={pending}>
                {pending
                  ? t("sending")
                  : invitePending
                    ? t("confirmReissue")
                    : t("confirm")}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>{t("done")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisconnectButton({
  merchantId,
  merchantName,
}: {
  merchantId: string;
  merchantName: string;
}) {
  const t = useTranslations("merchants.admin.disconnect");
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | {
        kind: "ready";
        affectedPlaces: AffectedPlace[];
        canDisconnect: boolean;
      }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [previewPending, startPreview] = useTransition();
  const [confirmPending, startConfirm] = useTransition();

  function onOpenChange(next: boolean) {
    if (!next && (previewPending || confirmPending)) return;
    setOpen(next);
    setError(null);
    if (!next) {
      setPreview({ kind: "idle" });
      return;
    }
    setPreview({ kind: "loading" });
    startPreview(async () => {
      const result = await previewDisconnectMerchantAction({ merchantId });
      if ("error" in result) {
        setPreview({ kind: "error", message: result.error });
      } else {
        setPreview({
          kind: "ready",
          affectedPlaces: result.affectedPlaces,
          canDisconnect: result.canDisconnect,
        });
      }
    });
  }

  function onConfirm() {
    setError(null);
    startConfirm(async () => {
      const result = await disconnectMerchantAction({ merchantId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setPreview({ kind: "idle" });
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Unplug className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { merchantName })}
          </DialogDescription>
        </DialogHeader>

        {preview.kind === "loading" && (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        )}

        {preview.kind === "error" && (
          <Alert variant="destructive">
            <AlertDescription>{preview.message}</AlertDescription>
          </Alert>
        )}

        {preview.kind === "ready" && (
          <div className="space-y-3">
            {!preview.canDisconnect && (
              <Alert variant="destructive">
                <AlertDescription>{t("balanceBlock")}</AlertDescription>
              </Alert>
            )}

            <p className="text-sm">
              {t("affectedHeading", { count: preview.affectedPlaces.length })}
            </p>

            <ul className="space-y-1.5">
              {preview.affectedPlaces.map((p) => (
                <li
                  key={p.placeId}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {p.localMerchantName ?? p.placeName}
                    </div>
                    {p.localMerchantName &&
                      p.localMerchantName !== p.placeName && (
                        <div className="truncate text-xs text-muted-foreground">
                          {p.placeName}
                        </div>
                      )}
                  </div>
                  <span
                    className={cn(
                      "tabular-nums",
                      p.balanceCents === null
                        ? "text-muted-foreground"
                        : p.balanceCents === 0
                          ? "text-muted-foreground"
                          : "font-medium text-warning",
                    )}
                  >
                    {p.balanceCents === null
                      ? "—"
                      : (p.balanceCents / 100).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={confirmPending}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={
              preview.kind !== "ready" ||
              !preview.canDisconnect ||
              confirmPending
            }
          >
            {confirmPending ? t("disconnecting") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectButton({
  merchantId,
  merchantName,
}: {
  merchantId: string;
  merchantName: string;
}) {
  const t = useTranslations("merchants.admin.review");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onReject = () => {
    setError(null);
    if (!note.trim()) {
      setError(t("reasonRequired"));
      return;
    }
    startTransition(async () => {
      const result = await rejectMerchantAction({ merchantId, note });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setNote("");
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        {t("reject")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("rejectTitle")}</DialogTitle>
          <DialogDescription>
            {t("rejectDescription", { merchantName })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`reject-note-${merchantId}`}>
            {t("rejectReasonLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <textarea
            id={`reject-note-${merchantId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("rejectReasonPlaceholder")}
            className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            required
          />
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
          <Button variant="destructive" onClick={onReject} disabled={pending}>
            {pending ? t("rejecting") : t("rejectConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
