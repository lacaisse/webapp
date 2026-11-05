// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FUND_APEX } from "@/services/fund/host";
import {
  NAME_MIN_LENGTH,
  SUBDOMAIN_MAX_LENGTH,
  SUBDOMAIN_MIN_LENGTH,
  toSubdomain,
} from "@/services/fund/schema";
import {
  checkJoinCodeAction,
  joinAction,
  type JoinField,
} from "@/services/fund-setup/join-actions";
import {
  JoinSchema,
  PASSWORD_MIN_LENGTH,
  type JoinInput,
  type JoinValues,
} from "@/services/fund-setup/schema";
import {
  isWellFormedWaiverCode,
  normaliseWaiverCode,
} from "@/services/fund-setup/waiver-codes";

// The account + fund form. Field errors come back as translation keys from
// the resolver and as translated text from the action; the {min}/{max}
// placeholders differ per field, so each field interpolates its own
// constants.
const FIELD_PARAMS: Record<JoinField, Record<string, number>> = {
  code: {},
  email: {},
  password: { min: PASSWORD_MIN_LENGTH },
  name: { min: NAME_MIN_LENGTH },
  subdomain: { min: SUBDOMAIN_MIN_LENGTH, max: SUBDOMAIN_MAX_LENGTH },
};
const KEY_PREFIX = /^(funds|auth|join)\./;

// A code the page found in the URL: formatted and labelled when it checked
// out, as typed with the page's verdict when it didn't.
export type JoinFormCode = { value: string; label?: string; error?: string };

// What the form knows about the code in its field: the lookup's verdict, or
// nothing yet (the field is empty, or changed since the last check).
type CodeStatus =
  | { kind: "ok"; label: string }
  | { kind: "error"; message: string }
  | { kind: "checking" };

export function JoinForm({ initialCode }: { initialCode?: JoinFormCode }) {
  const t = useTranslations("join");
  const tRoot = useTranslations();

  const [pending, startTransition] = useTransition();
  // Set when the answer went by email (the address already has an account —
  // the screen never says so, only that an email went out).
  const [sentTo, setSentTo] = useState<string | null>(null);

  // "I have an invite code": the field stays out of the way until asked for,
  // and is there from the start when a code came with the URL — checked or
  // not, so the holder of a dead link sees why on the same screen.
  const [codeOpen, setCodeOpen] = useState(Boolean(initialCode));
  const [codeStatus, setCodeStatus] = useState<CodeStatus | null>(() => {
    if (initialCode?.label !== undefined) return { kind: "ok", label: initialCode.label };
    if (initialCode?.error !== undefined) return { kind: "error", message: initialCode.error };
    return null;
  });
  // A check still in flight when the field changes must not land.
  const checkSeq = useRef(0);

  const form = useForm<JoinInput, unknown, JoinValues>({
    resolver: zodResolver(JoinSchema),
    defaultValues: {
      code: initialCode?.value ?? "",
      email: "",
      password: "",
      name: "",
      subdomain: "",
    },
  });

  // Propose the subdomain from the fund name until the person edits it.
  const name = useWatch({ control: form.control, name: "name" });
  const subdomainDirty = form.formState.dirtyFields.subdomain;
  useEffect(() => {
    if (!subdomainDirty) {
      form.setValue("subdomain", toSubdomain(name ?? ""), {
        shouldValidate: false,
        shouldDirty: false,
      });
    }
  }, [name, subdomainDirty, form]);

  // The code is looked at when the field is left: a shape check here, the
  // never-consuming lookup on the server (the submit checks it again and
  // claims it). An empty field is no code.
  const checkCode = async () => {
    const seq = ++checkSeq.current;
    const raw = form.getValues("code") ?? "";
    const normalised = normaliseWaiverCode(raw);
    form.clearErrors("code");
    if (!normalised) {
      setCodeStatus(null);
      return;
    }
    if (!isWellFormedWaiverCode(normalised)) {
      setCodeStatus({ kind: "error", message: t("errors.codeInvalid") });
      return;
    }
    setCodeStatus({ kind: "checking" });
    const result = await checkJoinCodeAction(raw);
    if (seq !== checkSeq.current) return;
    if (result.kind === "ok") {
      form.setValue("code", result.code, { shouldDirty: true });
      setCodeStatus({ kind: "ok", label: result.label });
    } else {
      setCodeStatus({
        kind: "error",
        message: t(result.kind === "too_many" ? "errors.tooMany" : "errors.codeInvalid"),
      });
    }
  };

  const onSubmit = (values: JoinValues) =>
    startTransition(async () => {
      const result = await joinAction(values);
      if ("error" in result) {
        if (result.field) {
          if (result.field === "code") setCodeOpen(true);
          form.setError(result.field, { message: result.error });
        } else {
          form.setError("root", { message: result.error });
        }
        return;
      }
      if ("sentTo" in result) {
        setSentTo(result.sentTo);
        return;
      }
      // A full navigation: the exchange lives on the fund's own host.
      window.location.assign(result.redirectTo);
    });

  // The code field's handlers wrap RHF's: the field is registered once, and
  // the change / blur work rides on the JSX props (an event handler is never
  // run during render — the lint can tell that here, not inside register()).
  const codeField = form.register("code");

  const errors = form.formState.errors;
  const fieldError = (field: JoinField) => {
    const message = errors[field]?.message;
    if (!message) return null;
    return KEY_PREFIX.test(message)
      ? tRoot(message as never, FIELD_PARAMS[field] as never)
      : message;
  };

  if (sentTo) {
    return (
      <Alert>
        <AlertDescription>{t("checkInbox", { email: sentTo })}</AlertDescription>
      </Alert>
    );
  }

  // Under the code field, in order of what matters most: a refusal from the
  // submit or the resolver, then the lookup's verdict, else what a code does.
  let codeNote: React.ReactNode;
  const codeFieldError = fieldError("code");
  if (codeFieldError) {
    codeNote = <p className="text-sm text-destructive">{codeFieldError}</p>;
  } else if (codeStatus?.kind === "ok") {
    codeNote = (
      <p className="flex items-start gap-1.5 text-sm">
        <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t("codeAccepted", { label: codeStatus.label })}</span>
      </p>
    );
  } else if (codeStatus?.kind === "error") {
    codeNote = <p className="text-sm text-destructive">{codeStatus.message}</p>;
  } else if (codeStatus?.kind === "checking") {
    codeNote = <p className="text-xs text-muted-foreground">{t("codeChecking")}</p>;
  } else {
    codeNote = <p className="text-xs text-muted-foreground">{t("codeHint")}</p>;
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      <fieldset className="space-y-4" disabled={pending}>
        <legend className="text-sm font-medium">{t("account")}</legend>
        <div className="space-y-2">
          <Label htmlFor="email">{t("email")}</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
          {errors.email && <p className="text-sm text-destructive">{fieldError("email")}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t("password")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...form.register("password")}
          />
          {errors.password ? (
            <p className="text-sm text-destructive">{fieldError("password")}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("passwordHint", { min: PASSWORD_MIN_LENGTH })}
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-4" disabled={pending}>
        <legend className="text-sm font-medium">{t("fund")}</legend>
        <div className="space-y-2">
          <Label htmlFor="name">{t("name")}</Label>
          <Input id="name" autoComplete="organization" {...form.register("name")} />
          {errors.name && <p className="text-sm text-destructive">{fieldError("name")}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="subdomain">{t("subdomain")}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="subdomain"
              autoComplete="off"
              spellCheck={false}
              {...form.register("subdomain")}
            />
            <span className="text-sm text-muted-foreground whitespace-nowrap">.{FUND_APEX}</span>
          </div>
          {errors.subdomain && (
            <p className="text-sm text-destructive">{fieldError("subdomain")}</p>
          )}
        </div>
      </fieldset>

      {codeOpen ? (
        <fieldset className="space-y-2" disabled={pending}>
          <Label htmlFor="code">{t("code")}</Label>
          <Input
            id="code"
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            // Opened by the link below: the person wants to type here.
            autoFocus={!initialCode}
            className="font-mono uppercase tracking-wider"
            aria-invalid={codeFieldError || codeStatus?.kind === "error" ? true : undefined}
            {...codeField}
            onChange={(e) => {
              void codeField.onChange(e);
              checkSeq.current++;
              setCodeStatus(null);
            }}
            onBlur={(e) => {
              void codeField.onBlur(e);
              void checkCode();
            }}
          />
          {codeNote}
        </fieldset>
      ) : (
        <p className="text-sm">
          <button
            type="button"
            onClick={() => setCodeOpen(true)}
            className="text-muted-foreground underline hover:text-foreground"
          >
            {t("haveCode")}
          </button>
        </p>
      )}

      {errors.root && (
        <Alert variant="destructive">
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
