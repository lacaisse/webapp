// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { LocaleSwitcher } from "@/components/locale-switcher";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { findTopUpForCard } from "@/services/card-topup/data";
import { requireCurrentFund } from "@/services/fund/server";

import { TopUpStatusPoller } from "./status-poller";

// Where the member's bank sends them back after signing (or abandoning) the
// top-up payment: `/pay/<serial>/return?topup=<CardTopUp.id>&paymentRequestId=<id>`
// (CitizenPay appends paymentRequestId). The page only reads; the poller's
// server action records the payment request id, checks CitizenPay every few
// seconds and mints once the request is signed (services/card-topup/settle.ts).
// If the member closes the tab, the bank-sync cron's sweep finishes the job.

export default async function TopUpReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ serial: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const fund = await requireCurrentFund();
  const { serial } = await params;
  const query = await searchParams;
  const topUpId = typeof query.topup === "string" ? query.topup : null;
  const prRaw =
    typeof query.paymentRequestId === "string" ? query.paymentRequestId : null;
  const paymentRequestId =
    prRaw && /^\d{1,12}$/.test(prRaw) ? Number(prRaw) : undefined;

  if (fund.allocationMode !== "PAY_AND_GO" || !topUpId) notFound();
  const topUp = await findTopUpForCard(fund.id, serial, topUpId);
  if (!topUp) notFound();

  const t = await getTranslations("cotisation.topUp.return");

  return (
    <div className="w-full max-w-xl space-y-6">
      <div className="flex justify-end">
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
          <CardTitle className="text-xl">{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TopUpStatusPoller
            serial={serial}
            topUpId={topUp.id}
            paymentRequestId={paymentRequestId}
            fundName={fund.name}
            initialStatus={topUp.status.toLowerCase() as never}
            amountCents={topUp.amountCents}
          />
        </CardContent>
      </Card>
    </div>
  );
}
