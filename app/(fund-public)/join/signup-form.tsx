// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  Controller,
  useForm,
  useWatch,
  type FieldErrors,
  type Resolver,
} from "react-hook-form";

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
import { signupMemberAction } from "@/services/member/actions";
import type { SignupPrefill } from "@/services/member/prefill";
import {
  SignupFormSchema,
  type SignupFormInput,
} from "@/services/member/schema";
import { buildExtrasSchema } from "@/services/onboarding/extras-schema";
import type { FormStep } from "@/services/onboarding/form-steps";
import { isFieldVisible } from "@/services/onboarding/visibility";
import {
  OnboardingFieldInput,
  type FieldValue,
  type OnboardingFieldDef,
} from "../onboarding-field-input";

// The public member signup form. A fund with no configured steps gets exactly
// one page — the classic single-screen form. With steps, the same single
// `useForm` spans every page (so nothing is lost navigating back and forth)
// and only the last page submits.

type StepField = OnboardingFieldDef & { position: number; stepId: string | null };

export function SignupForm({
  steps,
  referralCode,
  showContribution,
  tierMinimums,
  prefill,
  cancelUrl,
}: {
  steps: FormStep<StepField>[];
  referralCode: string | null;
  // Only FIXED_PERIOD funds with tiers ask for a commitment amount.
  showContribution: boolean;
  // Signup-visible tiers' minContribution by tier id — floors the commitment
  // amount when the form also collects a tier (builtin tierId, issue #158).
  tierMinimums: Record<string, number>;
  prefill: SignupPrefill;
  cancelUrl: string | null;
}) {
  const t = useTranslations("members.signup");
  const tRoot = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const allFields = useMemo(
    () => steps.flatMap((s) => s.fields),
    [steps],
  );
  const isMultiStep = steps.length > 1;
  const lastIndex = steps.length - 1;

  // The static schema can't know which extras this fund asks for, so the
  // per-field `required` rules are compiled from the runtime definitions.
  // Client-side UX only — the action re-checks them against the DB. The
  // superRefine floors the commitment amount against the chosen tier's
  // minimum (issue #158); its message is translated here rather than being a
  // key because the key needs the {min} parameter, which translateError
  // can't carry.
  const resolverSchema = useMemo(
    () =>
      SignupFormSchema.extend({ extras: buildExtrasSchema(allFields) }).superRefine(
        (data, ctx) => {
          const extras = data.extras as Record<string, unknown> | undefined;
          const tierId = extras?.tierId;
          if (typeof tierId !== "string" || !tierId) return;
          const min = tierMinimums[tierId];
          if (min == null) return;
          // The amount lives either on the legacy hardcoded input or on the
          // admin-configured builtin field (issue #179) — never both.
          const fromExtras = extras?.contributionAmount;
          const raw =
            data.contributionAmount ||
            (typeof fromExtras === "string" ? fromExtras : "");
          const amount = Number(raw);
          if (!raw || Number.isNaN(amount)) return;
          if (amount < min) {
            ctx.addIssue({
              code: "custom",
              path: data.contributionAmount
                ? ["contributionAmount"]
                : ["extras", "contributionAmount"],
              message: tRoot(
                "members.signup.errors.amountBelowTierMin" as never,
                { min } as never,
              ),
            });
          }
        },
      ),
    [allFields, tierMinimums, tRoot],
  );

  const form = useForm<SignupFormInput>({
    // The extras half of this schema is built at runtime, so its inferred
    // shape is `Record<string, unknown>` rather than the declared
    // `Record<string, ExtraValue>`. The values it produces are the same ones
    // SignupFormSchema describes — only the static type is wider.
    resolver: zodResolver(resolverSchema) as Resolver<SignupFormInput>,
    defaultValues: {
      firstName: prefill.firstName,
      lastName: prefill.lastName,
      email: prefill.email,
      contributionAmount: prefill.contributionAmount,
      remindersOptOut: false,
      extras: Object.fromEntries(
        allFields.map((f) => [
          f.key,
          prefill.extras[f.key] ?? defaultValueFor(f),
        ]),
      ),
    },
  });

  // How far the visitor has actually got. Deep-linking to `?step=3` on a fresh
  // load must not skip the questions in between, so the URL is clamped to
  // this — it only ever grows by passing validation on the page before.
  const [maxVisited, setMaxVisited] = useState(0);

  const requested = parseStepParam(searchParams.get("step"));
  const urlStep = Math.min(Math.max(requested, 0), Math.min(maxVisited, lastIndex));
  const [step, setStep] = useState(urlStep);

  // Re-sync when the URL changes from outside — browser back/forward. Same
  // adjust-during-render pattern as components/table-search.tsx (React's
  // recommended alternative to a setState effect).
  const [prevUrlStep, setPrevUrlStep] = useState(urlStep);
  if (urlStep !== prevUrlStep) {
    setPrevUrlStep(urlStep);
    setStep(urlStep);
  }

  const goToStep = (next: number) => {
    setStep(next);
    setMaxVisited((m) => Math.max(m, next));
    // Single-page forms leave the URL alone — no reason to dirty a link the
    // fund's website handed out.
    if (!isMultiStep) return;
    const params = new URLSearchParams(searchParams);
    if (next === 0) params.delete("step");
    else params.set("step", String(next + 1));
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };

  // Which inputs live on a given page: identity always leads page 1, the
  // commitment amount and reminder opt-out always close the last one.
  const namesForStep = (index: number): (keyof SignupFormInput | `extras.${string}`)[] => {
    const names: (keyof SignupFormInput | `extras.${string}`)[] = [];
    if (index === 0) names.push("firstName", "lastName", "email");
    for (const field of steps[index].fields) {
      names.push(`extras.${field.key}`);
    }
    if (index === lastIndex && showContribution) names.push("contributionAmount");
    return names;
  };

  // preventDefault is load-bearing, not decoration. This handler awaits
  // validation, so the click's default action is still pending when the
  // resulting re-render swaps this button for the last step's submit button.
  // The browser then performs that default action against the morphed
  // element and submits the form — advancing a step would create the member
  // halfway through the form. Cancelling the event up front kills that path;
  // the distinct `key`s on the two buttons stop the morph as well.
  const onNext = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const valid = await form.trigger(namesForStep(step) as never);
    if (valid) goToStep(step + 1);
  };

  const onSubmit = (data: SignupFormInput) =>
    startTransition(async () => {
      const { extras, ...builtins } = data;
      const result = await signupMemberAction({
        builtins,
        applicationData: extras,
        referralCode,
      });
      if ("error" in result) {
        // A terminal failure carries the fund's configured error URL; anything
        // the visitor can fix stays on the form.
        if (result.redirectTo) {
          window.location.href = result.redirectTo;
          return;
        }
        if (result.field) {
          // The commitment amount renders either as the legacy hardcoded
          // input (last page) or as the admin-configured builtin field
          // (issue #179, wherever the admin placed it) — map the server's
          // field name to whichever exists on this form.
          const isBuiltinContribution =
            result.field === "contributionAmount" && !showContribution;
          form.setError(
            isBuiltinContribution
              ? ("extras.contributionAmount" as never)
              : result.field,
            { message: result.error },
          );
          // Send the visitor to the page that renders the offending input:
          // identity fields all live on page 1.
          const builtinStep = steps.findIndex((s) =>
            s.fields.some((f) => f.key === "contributionAmount"),
          );
          const target =
            result.field === "contributionAmount"
              ? isBuiltinContribution && builtinStep !== -1
                ? builtinStep
                : lastIndex
              : 0;
          if (step !== target) goToStep(target);
        } else {
          form.setError("root", { message: result.error });
        }
        return;
      }
      window.location.href = result.redirectTo;
    });

  // Each page is validated before the visitor leaves it, but they can go back
  // (browser or the Back button) and clear a required answer before
  // submitting. Without this, submit would fail on a page that doesn't render
  // the offending input and nothing visible would happen.
  const onInvalid = (formErrors: FieldErrors<SignupFormInput>) => {
    const target = firstStepWithError(formErrors);
    if (target !== null && target !== step) goToStep(target);
  };

  const firstStepWithError = (
    formErrors: FieldErrors<SignupFormInput>,
  ): number | null => {
    if (formErrors.firstName || formErrors.lastName || formErrors.email) {
      return 0;
    }
    const extras = formErrors.extras as Record<string, unknown> | undefined;
    if (extras) {
      const index = steps.findIndex((s) =>
        s.fields.some((f) => extras[f.key]),
      );
      if (index !== -1) return index;
    }
    if (formErrors.contributionAmount) return lastIndex;
    return null;
  };

  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) => {
    if (!msg) return null;
    if (msg.startsWith("members.")) return tRoot(msg as never);
    return msg;
  };

  const current = steps[step];
  const isLast = step === lastIndex;

  // Re-evaluated on every keystroke so a field like `householdincome`
  // appears the moment `householdAdults` crosses its threshold. The action
  // re-checks visibility server-side regardless — this is UX only.
  const extrasValues = (useWatch({ control: form.control, name: "extras" }) ??
    {}) as Record<string, unknown>;
  const visibleFields = current.fields.filter((field) =>
    isFieldVisible(field.visibleIf, extrasValues),
  );

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit, onInvalid)}
      className="space-y-4"
    >
      {isMultiStep && (
        <StepProgress
          steps={steps}
          current={step}
          label={t("stepper.progress", {
            current: step + 1,
            total: steps.length,
          })}
        />
      )}

      {current.title && (
        <div className="space-y-1">
          <h2 className="text-base font-medium">{current.title}</h2>
          {current.description && (
            <p className="text-sm text-muted-foreground">
              {current.description}
            </p>
          )}
        </div>
      )}

      {step === 0 && (
        <>
          <div className="space-y-2">
            <Label htmlFor="firstName">
              {t("firstName")}
              <span className="ml-1 text-destructive" aria-hidden>
                *
              </span>
            </Label>
            {/* `defaultValue` is what actually paints the prefilled value.
                Base UI's Input only takes a value when it is controlled or
                given defaultValue; RHF's register() supplies neither, so
                without this the prefill lives in form state but the visitor
                sees an empty box. Same for the three inputs below. */}
            <Input
              id="firstName"
              autoComplete="given-name"
              defaultValue={prefill.firstName}
              {...form.register("firstName")}
            />
            {errors.firstName && (
              <p className="text-sm text-destructive">
                {translateError(errors.firstName.message)}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="lastName">
              {t("lastName")}
              <span className="ml-1 text-destructive" aria-hidden>
                *
              </span>
            </Label>
            <Input
              id="lastName"
              autoComplete="family-name"
              defaultValue={prefill.lastName}
              {...form.register("lastName")}
            />
            {errors.lastName && (
              <p className="text-sm text-destructive">
                {translateError(errors.lastName.message)}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">
              {t("email")}
              <span className="ml-1 text-destructive" aria-hidden>
                *
              </span>
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              defaultValue={prefill.email}
              {...form.register("email")}
            />
            {errors.email && (
              <p className="text-sm text-destructive">
                {translateError(errors.email.message)}
              </p>
            )}
          </div>
        </>
      )}

      {visibleFields.map((field) => (
        <Controller
          key={field.id}
          control={form.control}
          name={`extras.${field.key}` as `extras.${string}`}
          render={({ field: rhfField, fieldState }) => (
            <OnboardingFieldInput
              field={field}
              value={rhfField.value as FieldValue | undefined}
              onChange={rhfField.onChange}
              error={translateError(fieldState.error?.message) ?? undefined}
            />
          )}
        />
      ))}

      {isLast && showContribution && (
        <div className="space-y-2">
          <Label htmlFor="contributionAmount">{t("contributionAmount")}</Label>
          <Input
            id="contributionAmount"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            defaultValue={prefill.contributionAmount}
            {...form.register("contributionAmount")}
          />
          <p className="text-xs text-muted-foreground">
            {t("contributionAmountHint")}
          </p>
          {errors.contributionAmount && (
            <p className="text-sm text-destructive">
              {translateError(errors.contributionAmount.message)}
            </p>
          )}
        </div>
      )}

      {isLast && (
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            {...form.register("remindersOptOut")}
            className="mt-0.5 size-4 rounded border-input"
          />
          <span>{t("remindersOptOut")}</span>
        </label>
      )}

      {errors.root && (
        <Alert variant="destructive">
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {step > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => goToStep(step - 1)}
            disabled={pending}
          >
            {t("stepper.back")}
          </Button>
        )}

        {isLast ? (
          <Button key="submit" type="submit" className="flex-1" disabled={pending}>
            {pending ? t("submitting") : t("submit")}
          </Button>
        ) : (
          <Button
            key="next"
            type="button"
            className="flex-1"
            onClick={onNext}
            disabled={pending}
          >
            {t("stepper.next")}
          </Button>
        )}
      </div>

      {cancelUrl && <CancelButton cancelUrl={cancelUrl} disabled={pending} />}
    </form>
  );
}

// Leaving discards everything typed so far, so it always goes through an
// in-app confirmation (never window.confirm — see AGENTS.md).
function CancelButton({
  cancelUrl,
  disabled,
}: {
  cancelUrl: string;
  disabled: boolean;
}) {
  const t = useTranslations("members.signup.cancel");
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            disabled={disabled}
          >
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={leaving}
          >
            {t("stay")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              window.location.href = cancelUrl;
            }}
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepProgress({
  steps,
  current,
  label,
}: {
  steps: FormStep<StepField>[];
  current: number;
  label: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5" aria-hidden>
        {steps.map((s, i) => (
          <div
            key={s.id ?? i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= current ? "bg-primary" : "bg-muted"
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

// `?step=2` is 1-based for humans; the array is 0-based. Anything unparseable
// falls back to the first page.
function parseStepParam(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 0;
  return parsed - 1;
}

function defaultValueFor(field: OnboardingFieldDef): FieldValue {
  if (field.type === "MULTISELECT") return [];
  if (field.type === "CHECKBOX") return false;
  return "";
}
