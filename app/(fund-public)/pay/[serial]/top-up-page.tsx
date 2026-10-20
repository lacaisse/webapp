// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowLeft, Info, ShieldCheck } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TOP_UP_MAX_CENTS,
  TOP_UP_MIN_CENTS,
  TOP_UP_PRESETS_CENTS,
} from "@/services/card-topup/amount";
import {
  isTopUpReady,
  listTopUpBanks,
  loadTopUpCard,
} from "@/services/card-topup/data";
import type { Fund } from "@/services/db/generated/client";

import { TopUpForm } from "./top-up-form";

// Open-banking card top-up for PAY_AND_GO funds (see ./page.tsx). The member
// picks an amount and their bank; ./actions.ts starts the CitizenPay payment
// request and sends them to the bank; ./return polls until the card is
// credited. Any card of the fund can be topped up — a member isn't required.

export async function TopUpPage({ fund, serial }: { fund: Fund; serial: string }) {
  const card = await loadTopUpCard(fund.id, serial);
  if (!card) notFound();

  const t = await getTranslations("cotisation");
  const format = await getFormatter();
  const money = (cents: number) =>
    format.number(cents / 100, { style: "currency", currency: "EUR" });

  const name = card.member
    ? `${card.member.firstName} ${card.member.lastName}`.trim()
    : "";

  let notice: string | null = null;
  if (card.status === "BLOCKED") {
    notice = t("topUp.cardBlocked", { fundName: fund.name });
  } else if (!isTopUpReady(fund) || !card.account) {
    notice = t("topUp.unavailable", { fundName: fund.name });
  }

  return (
    <div className="w-full max-w-xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("back")}
        </Link>
        {/* Arrives from the wallet with no locale cookie — let them switch. */}
        <LocaleSwitcher />
      </div>

      <Card>
        <CardHeader className="items-center text-center">
          {fund.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fund.logoUrl}
              alt={fund.name}
              className="mx-auto mb-2 h-12 w-auto object-contain"
            />
          )}
          <CardTitle className="text-xl">{t("topUp.title")}</CardTitle>
          <CardDescription>
            {name
              ? t("topUp.greeting", { name })
              : t("topUp.greetingNoName")}
          </CardDescription>
          <p className="font-mono text-xs text-muted-foreground">
            {t("topUp.cardLabel", { serial: card.serialNumber })}
          </p>
        </CardHeader>

        <CardContent className="space-y-6">
          {notice ? (
            <Alert>
              <Info className="size-4" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : (
            <Suspense fallback={<TopUpFormSkeleton />}>
              <TopUpFormWithBanks
                fund={fund}
                serial={card.serialNumber}
                amountHint={t("topUp.amountHint", {
                  min: money(TOP_UP_MIN_CENTS),
                  max: money(TOP_UP_MAX_CENTS),
                })}
                noBanks={t("topUp.noBanks")}
              />
            </Suspense>
          )}

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            {t("topUp.secure", { fundName: fund.name })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// The bank directory is an external call — stream it in behind a skeleton.
async function TopUpFormWithBanks({
  fund,
  serial,
  amountHint,
  noBanks,
}: {
  fund: Fund;
  serial: string;
  amountHint: string;
  noBanks: string;
}) {
  const banks = await listTopUpBanks(fund);
  if (!banks || banks.length === 0) {
    return (
      <Alert>
        <Info className="size-4" />
        <AlertDescription>{noBanks}</AlertDescription>
      </Alert>
    );
  }
  return (
    <TopUpForm
      serial={serial}
      presetsCents={[...TOP_UP_PRESETS_CENTS]}
      amountHint={amountHint}
      banks={banks.map((b) => ({
        id: b.id,
        name: b.name,
        logoUrl: b.logoUrl,
        requiresDebtorIban: b.requiresDebtorIban,
      }))}
    />
  );
}

function TopUpFormSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-2">
        {TOP_UP_PRESETS_CENTS.map((c) => (
          <Skeleton key={c} className="h-11 w-full" />
        ))}
      </div>
      <Skeleton className="h-9 w-full" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
