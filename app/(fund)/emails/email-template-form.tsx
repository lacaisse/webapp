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
} from "@/services/email/template-actions";
import type { EditableEmailType } from "@/services/email/template-config";
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@/services/i18n/config";

export type TestMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

export type TestSendAction = (input: {
  memberId: string;
  toEmail: string;
  locale: string;
}) => Promise<{ ok: true } | { error: string }>;

type LocaleState = {
  override: { subject: string; bodyHtml: string } | null;
  base: { subject: string; bodyHtml: string };
};

// Editor for a per-fund editable email template (subject + rich-HTML body),
// authored independently per language. A language tab bar switches which locale
// is being edited; unsaved edits are kept per-locale so switching never loses
// work. Each language has a live server-rendered preview in the fund's branded
// shell and shares one test-send picker (which renders in the active language).
export function EmailTemplateForm({
  type,
  byLocale,
  defaultLocale,
  variables,
  testMembers,
  testAction,
}: {
  type: EditableEmailType;
  byLocale: Record<string, LocaleState>;
  // Language shown first — the fund's own default locale.
  defaultLocale: string;
  variables: readonly string[];
  testMembers: TestMember[];
  testAction: TestSendAction;
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  const tRoot = useTranslations("fund.settings");
  const tLocale = useTranslations("locale");

  const initialLocale = byLocale[defaultLocale]
    ? defaultLocale
    : SUPPORTED_LOCALES[0];
  const [activeLocale, setActiveLocale] = useState(initialLocale);

  // Per-locale drafts (seeded from the saved override, else the built-in
  // default) so edits survive language switches until saved or reset.
  const [drafts, setDrafts] = useState<
    Record<string, { subject: string; bodyHtml: string }>
  >(() =>
    Object.fromEntries(
      SUPPORTED_LOCALES.map((loc) => {
        const entry = byLocale[loc];
        const init = entry.override ?? entry.base;
        return [loc, { subject: init.subject, bodyHtml: init.bodyHtml }];
      }),
    ),
  );
  const [overridden, setOverridden] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      SUPPORTED_LOCALES.map((loc) => [loc, byLocale[loc].override !== null]),
    ),
  );

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const [resetting, startReset] = useTransition();

  const subject = drafts[activeLocale].subject;
  const bodyHtml = drafts[activeLocale].bodyHtml;
  const isOverridden = overridden[activeLocale];

  const setSubject = (value: string) => {
    setSaved(false);
    setDrafts((d) => ({ ...d, [activeLocale]: { ...d[activeLocale], subject: value } }));
  };
  const setBodyHtml = (value: string) => {
    setSaved(false);
    setDrafts((d) => ({ ...d, [activeLocale]: { ...d[activeLocale], bodyHtml: value } }));
  };

  const onLocaleChange = (loc: string) => {
    setSaved(false);
    setError(null);
    setActiveLocale(loc);
  };

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
      const result = await testAction({
        memberId: testMemberId,
        toEmail: testEmail,
        locale: activeLocale,
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
        type,
        locale: activeLocale,
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
  }, [type, activeLocale, subject, bodyHtml]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveEmailTemplateAction({
        type,
        locale: activeLocale,
        subject,
        bodyHtml,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
      setOverridden((o) => ({ ...o, [activeLocale]: true }));
    });
  };

  const onReset = () => {
    setError(null);
    setSaved(false);
    startReset(async () => {
      const result = await resetEmailTemplateAction({
        type,
        locale: activeLocale,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const base = byLocale[activeLocale].base;
      setDrafts((d) => ({
        ...d,
        [activeLocale]: { subject: base.subject, bodyHtml: base.bodyHtml },
      }));
      setOverridden((o) => ({ ...o, [activeLocale]: false }));
    });
  };

  return (
    <div className="space-y-6">
      {/* Language selector — each language is edited independently. */}
      <div
        role="tablist"
        aria-label={tLocale("label")}
        className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-sm"
      >
        {SUPPORTED_LOCALES.map((loc) => {
          const isActive = loc === activeLocale;
          return (
            <button
              key={loc}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onLocaleChange(loc)}
              className={
                "inline-flex h-7 items-center rounded-md px-3 font-medium transition-colors " +
                (isActive
                  ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {tLocale(loc as SupportedLocale)}
              {overridden[loc] && (
                <span
                  aria-hidden
                  className="ml-1.5 size-1.5 rounded-full bg-primary"
                  title={t("usingOverride")}
                />
              )}
            </button>
          );
        })}
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Editor column */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`${type}-template-subject`}>
                {t("subjectLabel")}
              </Label>
              <Input
                id={`${type}-template-subject`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${type}-template-body`}>{t("htmlLabel")}</Label>
              <textarea
                id={`${type}-template-body`}
                value={bodyHtml}
                onChange={(e) => setBodyHtml(e.target.value)}
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
                <span className="text-muted-foreground">
                  {t("previewSubject")}{" "}
                </span>
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
              : isOverridden
                ? t("usingOverride")
                : t("usingDefault")}
          </div>
          <div className="flex items-center gap-2">
            {isOverridden && (
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
          <p className="text-xs text-muted-foreground">{t("test.description")}</p>
        </div>

        {testMembers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("test.noMembers")}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${type}-test-member`}>
                  {t("test.memberLabel")}
                </Label>
                <select
                  id={`${type}-test-member`}
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
                <Label htmlFor={`${type}-test-email`}>{t("test.emailLabel")}</Label>
                <Input
                  id={`${type}-test-email`}
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
