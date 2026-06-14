// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { joinWaitlistAction } from "@/services/waitlist/actions";
import {
  WAITLIST_FUND_NAME_MAX,
  WaitlistSchema,
  type WaitlistInput,
} from "@/services/waitlist/schema";

const inputClass =
  "h-11 w-full rounded-lg border px-3.5 font-sans text-[15px] text-foreground outline-none transition-shadow focus:border-[var(--primary)] focus:ring-3 focus:ring-[var(--primary-tint)]";

export function WaitlistForm() {
  const t = useTranslations("landing.waitlist");
  const tRoot = useTranslations();

  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const form = useForm<WaitlistInput>({
    resolver: zodResolver(WaitlistSchema),
    defaultValues: { email: "", fundName: "" },
  });

  const onSubmit = (data: WaitlistInput) =>
    startTransition(async () => {
      const result = await joinWaitlistAction(data);
      if ("error" in result) {
        form.setError("root", { message: result.error });
      } else {
        setDone(true);
        form.reset();
      }
    });

  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) =>
    msg ? tRoot(msg as never, { max: WAITLIST_FUND_NAME_MAX } as never) : null;

  if (done) {
    return (
      <div
        className="flex items-start gap-3 rounded-lg border p-4"
        style={{
          background: "var(--card)",
          borderColor: "var(--border)",
        }}
      >
        <span className="lp-dot lp-dot-pulse mt-1.5" />
        <div>
          <div className="font-heading text-foreground" style={{ fontSize: 16 }}>
            {t("successTitle")}
          </div>
          <p
            className="mt-1 text-sm leading-relaxed"
            style={{ color: "var(--muted-foreground)" }}
          >
            {t("successBody")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      className="flex flex-col gap-2.5"
      noValidate
    >
      <div>
        <label htmlFor="wl-email" className="sr-only">
          {t("emailLabel")}
        </label>
        <input
          id="wl-email"
          type="email"
          autoComplete="email"
          placeholder={t("emailPlaceholder")}
          className={inputClass}
          style={{ background: "var(--card)", borderColor: "var(--border)" }}
          aria-invalid={!!errors.email}
          {...form.register("email")}
        />
        {errors.email && (
          <p className="mt-1.5 text-xs" style={{ color: "oklch(0.55 0.20 27)" }}>
            {translateError(errors.email.message)}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="wl-fund" className="sr-only">
          {t("fundNameLabel")}
        </label>
        <input
          id="wl-fund"
          type="text"
          maxLength={WAITLIST_FUND_NAME_MAX}
          placeholder={t("fundNamePlaceholder")}
          className={inputClass}
          style={{ background: "var(--card)", borderColor: "var(--border)" }}
          aria-invalid={!!errors.fundName}
          {...form.register("fundName")}
        />
        {errors.fundName && (
          <p className="mt-1.5 text-xs" style={{ color: "oklch(0.55 0.20 27)" }}>
            {translateError(errors.fundName.message)}
          </p>
        )}
      </div>

      {errors.root && (
        <p className="text-sm" style={{ color: "oklch(0.55 0.20 27)" }}>
          {errors.root.message}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-lg px-[18px] text-[15px] font-medium text-primary-foreground no-underline transition-opacity hover:opacity-90 disabled:opacity-60"
        style={{ background: "var(--primary)" }}
      >
        {pending ? t("submitting") : `${t("submit")} →`}
      </button>
    </form>
  );
}
