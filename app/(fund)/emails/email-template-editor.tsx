// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, RotateCcw, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  previewEmailTemplateAction,
  saveTemplateLocalizationAction,
  sendTestEmailAction,
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

type LocaleContent = { subject: string; bodyHtml: string };

// The per-language editor for one email template — or, when templateId is null,
// a read-only view of the built-in default (subject/body disabled, no Save). A
// language tab bar switches which locale is edited; unsaved edits are kept per
// locale so switching never loses work. Each language has a live server-rendered
// preview in the fund's branded shell and a test-send picker.
export function EmailTemplateEditor({
  type,
  templateId,
  byLocale,
  defaultByLocale,
  variables,
  defaultLocale,
  testMembers,
}: {
  type: EditableEmailType;
  // null = the built-in default (read-only); a string = an editable template.
  templateId: string | null;
  // The template's authored content per language (null where a language hasn't
  // been authored yet — the default is shown for it until saved). Ignored when
  // templateId is null (the default view uses defaultByLocale directly).
  byLocale: Record<string, LocaleContent | null>;
  defaultByLocale: Record<string, LocaleContent>;
  variables: readonly string[];
  defaultLocale: string;
  testMembers: TestMember[];
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  const tRoot = useTranslations("fund.settings");
  const tLocale = useTranslations("locale");

  const readOnly = templateId === null;

  const initialLocale = SUPPORTED_LOCALES.includes(defaultLocale as never)
    ? (defaultLocale as SupportedLocale)
    : SUPPORTED_LOCALES[0];
  const [activeLocale, setActiveLocale] = useState<string>(initialLocale);

  // Per-locale drafts: the template's authored content, else the default (the
  // default is also what read-only mode shows).
  const [drafts, setDrafts] = useState<Record<string, LocaleContent>>(() =>
    Object.fromEntries(
      SUPPORTED_LOCALES.map((loc) => {
        const init = (!readOnly && byLocale[loc]) || defaultByLocale[loc];
        return [loc, { subject: init.subject, bodyHtml: init.bodyHtml }];
      }),
    ),
  );

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const subject = drafts[activeLocale].subject;
  const bodyHtml = drafts[activeLocale].bodyHtml;

  const setSubject = (value: string) => {
    setSaved(false);
    setDrafts((d) => ({
      ...d,
      [activeLocale]: { ...d[activeLocale], subject: value },
    }));
  };
  const setBodyHtml = (value: string) => {
    setSaved(false);
    setDrafts((d) => ({
      ...d,
      [activeLocale]: { ...d[activeLocale], bodyHtml: value },
    }));
  };

  const onLocaleChange = (loc: string) => {
    setSaved(false);
    setError(null);
    setActiveLocale(loc);
  };

  // Replace the active language's draft with the built-in default (client-side;
  // the admin still Saves to persist).
  const onLoadDefault = () => {
    setSaved(false);
    setError(null);
    const def = defaultByLocale[activeLocale];
    setDrafts((d) => ({
      ...d,
      [activeLocale]: { subject: def.subject, bodyHtml: def.bodyHtml },
    }));
  };

  // Test send: optional member (populates the email's data) + destination.
  const [testMemberId, setTestMemberId] = useState(testMembers[0]?.id ?? "");
  const [testEmail, setTestEmail] = useState(testMembers[0]?.email ?? "");
  const [testError, setTestError] = useState<string | null>(null);
  const [testSent, setTestSent] = useState(false);
  const [testing, startTest] = useTransition();

  const onTestMemberChange = (id: string) => {
    setTestSent(false);
    setTestError(null);
    setTestMemberId(id);
    const m = testMembers.find((mem) => mem.id === id);
    if (m) setTestEmail(m.email);
  };

  const onSendTest = () => {
    setTestError(null);
    setTestSent(false);
    startTest(async () => {
      const result = await sendTestEmailAction({
        type,
        templateId,
        memberId: testMemberId || null,
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
    if (readOnly || templateId === null) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveTemplateLocalizationAction({
        templateId,
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
          const authored = !readOnly && byLocale[loc] !== null;
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
              {authored && (
                <span
                  aria-hidden
                  className="ml-1.5 size-1.5 rounded-full bg-primary"
                  title={t("localeAuthored")}
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
                disabled={readOnly}
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
                disabled={readOnly}
                rows={14}
                spellCheck={false}
                className="w-full rounded-md bg-background px-2.5 py-1.5 font-mono text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
              />
              <p className="text-xs text-muted-foreground">{t("htmlHint")}</p>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
                {t("variablesHint")}
              </p>
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
                className="h-[420px] w-full bg-white"
              />
            </div>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!readOnly && (
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {saved && !pending ? tRoot("saved") : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onLoadDefault}
                disabled={pending}
              >
                <RotateCcw className="size-3.5" />
                {t("loadDefault")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? tRoot("saving") : tRoot("save")}
              </Button>
            </div>
          </div>
        )}
      </form>

      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{t("test.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("test.description")}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${type}-test-member`}>{t("test.memberLabel")}</Label>
            <select
              id={`${type}-test-member`}
              value={testMemberId}
              onChange={(e) => onTestMemberChange(e.target.value)}
              className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t("test.sampleData")}</option>
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
            disabled={testing || !testEmail.trim()}
          >
            <Send className="size-3.5" />
            {testing ? t("test.sending") : t("test.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}
