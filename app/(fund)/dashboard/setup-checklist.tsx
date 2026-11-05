// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { Check, ExternalLink } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SUBSCRIPTION_MONTHLY_EUR } from "@/services/fund-setup/config";
import type { CitizenPayDashboardUrls } from "@/services/fund-setup/citizenpay-dashboard";
import { getFundSetup, type FundSetup } from "@/services/fund-setup/server";
import type { SetupStep, SetupStepStatus } from "@/services/fund-setup/steps";
import { requireCurrentFund } from "@/services/fund/server";
import { cn } from "@/lib/utils";

// Fund setup checklist at the top of the admin dashboard: register on Citizen
// Pay → activate open banking → start the subscription. Rendered only while a
// step is left; a fully set-up fund never sees it.

const STATUS_BADGE = {
  done: "success",
  in_progress: "warning",
  todo: "default",
  blocked: "outline",
  unknown: "outline",
} as const satisfies Record<SetupStepStatus, "success" | "warning" | "default" | "outline">;

type Translator = Awaited<ReturnType<typeof getTranslations<"fund.dashboard.setup">>>;

export async function SetupChecklist() {
  const fund = await requireCurrentFund();
  const setup = await getFundSetup(fund);
  if (setup.complete) return null;

  const [t, format] = await Promise.all([
    getTranslations("fund.dashboard.setup"),
    getFormatter(),
  ]);
  const price = format.number(SUBSCRIPTION_MONTHLY_EUR, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
  const done = setup.steps.filter((step) => step.status === "done").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>
          {t("description", { done, total: setup.steps.length })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="divide-y divide-border">
          {setup.steps.map((step, i) => (
            <StepRow
              key={step.key}
              step={step}
              index={i + 1}
              t={t}
              price={price}
              urls={setup.urls}
              banking={setup.banking}
              waived={setup.waived}
            />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function StepRow({
  step,
  index,
  t,
  price,
  urls,
  banking,
  waived,
}: {
  step: SetupStep;
  index: number;
  t: Translator;
  price: string;
  urls: CitizenPayDashboardUrls;
  banking: FundSetup["banking"];
  waived: boolean;
}) {
  const isDone = step.status === "done";
  const showCta = !isDone && step.status !== "blocked";

  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums",
            isDone ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
          )}
        >
          {isDone ? <Check className="size-3.5" /> : index}
        </span>
        <div className={cn("min-w-0 space-y-0.5", isDone && "text-muted-foreground")}>
          <div className="font-medium">{stepTitle(step, t)}</div>
          <p className="text-sm text-muted-foreground">
            {stepDescription(step, t, price, banking, waived)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-9 sm:shrink-0 sm:justify-end sm:pl-0">
        <Badge variant={STATUS_BADGE[step.status]}>
          {t(`status.${step.status}`)}
        </Badge>
        {showCta && <StepCta step={step} t={t} urls={urls} />}
      </div>
    </li>
  );
}

function stepTitle(step: SetupStep, t: Translator): string {
  switch (step.key) {
    case "citizenpay":
      return t("citizenpay.title");
    case "banking":
      return t("banking.title");
    case "subscription":
      return t("subscription.title");
  }
}

function stepDescription(
  step: SetupStep,
  t: Translator,
  price: string,
  banking: FundSetup["banking"],
  waived: boolean,
): string {
  switch (step.key) {
    case "citizenpay":
      return t("citizenpay.description");
    case "banking":
      if (step.status === "in_progress") return t("banking.descriptionInProgress");
      if (step.status === "blocked") return t("banking.descriptionBlocked");
      if (step.status === "unknown") return t("banking.descriptionUnknown");
      // Bank connected on Citizen Pay, but its onboarding or the payment
      // initiation request is still on the fund.
      if (step.status === "todo" && banking.kind === "ok" && banking.status.connected) {
        return t("banking.descriptionConnectedTodo");
      }
      return t("banking.description");
    case "subscription":
      // Done without an acceptance: a waiver code was redeemed, or a platform
      // admin waived the fund. Don't quote a price it will never pay.
      if (waived) return t("subscription.descriptionWaived");
      return t("subscription.description", { price });
  }
}

function StepCta({
  step,
  t,
  urls,
}: {
  step: SetupStep;
  t: Translator;
  urls: CitizenPayDashboardUrls;
}) {
  switch (step.key) {
    case "citizenpay":
      return (
        <Link
          href="/settings?tab=citizenpay"
          className={buttonVariants({ size: "sm" })}
        >
          {t("citizenpay.cta")}
        </Link>
      );
    case "banking": {
      const inProgress = step.status === "in_progress";
      const bankPage = (
        <Link
          href="/bank"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {t("banking.secondary")}
        </Link>
      );
      // Citizen Pay didn't answer: we can't say what's left, so no CTA into
      // its dashboard — only the Bank page.
      if (step.status === "unknown") return bankPage;
      return (
        <>
          {bankPage}
          <a
            href={urls.banking}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({
              variant: inProgress ? "outline" : "default",
              size: "sm",
            })}
          >
            <ExternalLink className="size-3.5" />
            {inProgress ? t("banking.ctaInProgress") : t("banking.cta")}
          </a>
        </>
      );
    }
    case "subscription":
      return (
        <Link
          href="/settings?tab=subscription"
          className={buttonVariants({ size: "sm" })}
        >
          {t("subscription.cta")}
        </Link>
      );
  }
}

export function SetupChecklistSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-3.5 w-80 max-w-full" />
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
            >
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-3.5 w-full max-w-md" />
              </div>
              <Skeleton className="hidden h-7 w-36 rounded-lg sm:block" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
