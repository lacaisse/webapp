// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, RotateCcw, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  previewEmailTemplateAction,
  resetEmailTemplateAction,
  saveEmailTemplateAction,
  sendTestAllocationEmailAction,
} from "@/services/email/template-actions";

export type TestMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

// Editor for the per-fund ALLOCATION_CONFIRMATION email override. Subject + a
// rich-HTML body (source), with a live preview rendered server-side in the
// fund's branded shell using sample values. Validation re-runs server-side and
// any error string comes back translated. "Reset to default" drops the
// override and restores the built-in wording.
export function AllocationTemplateForm({
  initial,
  base,
  hasOverride,
  variables,
  testMembers,
}: {
  initial: { subject: string; bodyHtml: string };
  base: { subject: string; bodyHtml: string };
  hasOverride: boolean;
  variables: readonly string[];
  testMembers: TestMember[];
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  const tRoot = useTranslations("fund.settings");

  const [subject, setSubject] = useState(initial.subject);
  const [bodyHtml, setBodyHtml] = useState(initial.bodyHtml);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [overridden, setOverridden] = useState(hasOverride);
  const [pending, startTransition] = useTransition();
  const [resetting, startReset] = useTransition();

  // Test send: pick a member (populates the email's data) + the address to
  // deliver to (editable, defaults to the picked member's own email).
  const [testMemberId, setTestMemberId] = useState(testMembers[0]?.id ?? "");
  const [testEmail, setTestEmail] = useState(testMembers[0]?.email ?? "");
  const [testError, setTestError] = useState<string | null>(null);
  const [testSent, setTestSent] = useState(false);
  const [testing, startTest] = useTransition();

  const onTestMemberChange = (id: string) => {
    setTestSent(false);
    setTestError(null);
    setTestMemberId(id);
    // Convenience: prefill the destination with the picked member's address.
    const m = testMembers.find((m) => m.id === id);
    if (m) setTestEmail(m.email);
  };

  const onSendTest = () => {
    setTestError(null);
    setTestSent(false);
    startTest(async () => {
      const result = await sendTestAllocationEmailAction({
        memberId: testMemberId,
        toEmail: testEmail,
      });
      if ("error" in result) {
        setTestError(result.error);
        return;
      }
      setTestSent(true);
    });
  };

  // Debounced live preview (server-rendered branded HTML).
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      setPreviewing(true);
      const result = await previewEmailTemplateAction({
        type: "ALLOCATION_CONFIRMATION",
        subject,
        bodyHtml,
      });
      if (cancelled) return;
      if ("ok" in result) setPreviewHtml(result.html);
      setPreviewing(false);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [subject, bodyHtml]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveEmailTemplateAction({
        type: "ALLOCATION_CONFIRMATION",
        subject,
        bodyHtml,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
      setOverridden(true);
    });
  };

  const onReset = () => {
    setError(null);
    setSaved(false);
    startReset(async () => {
      const result = await resetEmailTemplateAction({
        type: "ALLOCATION_CONFIRMATION",
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSubject(base.subject);
      setBodyHtml(base.bodyHtml);
      setOverridden(false);
    });
  };

  return (
    <div className="space-y-6">
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Editor column */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="alloc-template-subject">{t("subjectLabel")}</Label>
            <Input
              id="alloc-template-subject"
              value={subject}
              onChange={(e) => {
                setSaved(false);
                setSubject(e.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="alloc-template-body">{t("htmlLabel")}</Label>
            <textarea
              id="alloc-template-body"
              value={bodyHtml}
              onChange={(e) => {
                setSaved(false);
                setBodyHtml(e.target.value);
              }}
              rows={14}
              spellCheck={false}
              className="w-full rounded-md bg-background px-2.5 py-1.5 font-mono text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">{t("htmlHint")}</p>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t("variablesHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {variables.map((v) => (
                <span
                  key={v}
                  title={t(`variables.${v}` as never)}
                  className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                >
                  {`{${v}}`}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Preview column */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label>{t("previewLabel")}</Label>
            {previewing && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          <div className="overflow-hidden rounded-md border border-border">
            <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">{t("previewSubject")} </span>
              <span className="font-medium">{subject}</span>
            </div>
            <iframe
              title={t("previewLabel")}
              sandbox=""
              srcDoc={previewHtml ?? ""}
              className="h-[460px] w-full bg-white"
            />
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {saved && !pending
            ? tRoot("saved")
            : overridden
              ? t("usingOverride")
              : t("usingDefault")}
        </div>
        <div className="flex items-center gap-2">
          {overridden && (
            <Dialog>
              <DialogTrigger
                render={
                  <Button type="button" variant="outline" disabled={resetting} />
                }
              >
                <RotateCcw className="size-3.5" />
                {t("reset")}
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("resetConfirmTitle")}</DialogTitle>
                  <DialogDescription>
                    {t("resetConfirmDescription")}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button type="button" variant="outline" />}>
                    {t("resetConfirmCancel")}
                  </DialogClose>
                  <DialogClose
                    render={
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={onReset}
                      />
                    }
                  >
                    {t("resetConfirmConfirm")}
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? tRoot("saving") : tRoot("save")}
          </Button>
        </div>
      </div>
    </form>

      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{t("test.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("test.description")}
          </p>
        </div>

        {testMembers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("test.noMembers")}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="test-member">{t("test.memberLabel")}</Label>
                <select
                  id="test-member"
                  value={testMemberId}
                  onChange={(e) => onTestMemberChange(e.target.value)}
                  className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {testMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {`${m.firstName} ${m.lastName}`.trim()} — {m.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="test-email">{t("test.emailLabel")}</Label>
                <Input
                  id="test-email"
                  type="email"
                  value={testEmail}
                  onChange={(e) => {
                    setTestSent(false);
                    setTestEmail(e.target.value);
                  }}
                  placeholder={t("test.emailPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>

            {testError && (
              <Alert variant="destructive">
                <AlertDescription>{testError}</AlertDescription>
              </Alert>
            )}

            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                {testSent && !testing ? t("test.sent") : null}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={onSendTest}
                disabled={testing || !testMemberId || !testEmail.trim()}
              >
                <Send className="size-3.5" />
                {testing ? t("test.sending") : t("test.send")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
