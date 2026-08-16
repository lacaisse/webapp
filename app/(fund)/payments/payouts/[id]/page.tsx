// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import QRCode from "qrcode";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Payout, PayoutStatus } from "@/services/citizenpay/types";
import { requireFundRole } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";
import { cn } from "@/lib/utils";

import { AddOrdersDialog } from "./add-orders-dialog";
import { CreateOrderDialog } from "./create-order-dialog";
import { ManualDeductionDialog } from "./manual-deduction-dialog";
import { OrdersExplorer } from "./orders-explorer";
import { PayoutPeriodDialog } from "./period-dialog";

import { getBankingStatus } from "../../../bank/data";
import {
  getAllPayoutOrders,
  getPayoutLiveStatus,
  getPayoutSummary,
  getPlaceOnChainBalance,
} from "../../data";
import { PayoutProcess } from "../../payout-process";

const STATUS_VARIANT: Record<
  PayoutStatus,
  "default" | "outline" | "success" | "warning"
> = {
  pending: "warning",
  "payment-pending": "outline",
  burnt: "outline",
  complete: "success",
};

export default async function PayoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireFundRole("ADMIN");
  const { id } = await params;

  const t = await getTranslations("fund.payments.settlement");
  const format = await getFormatter();
  const fund = await requireCurrentFund();

  const payout = await getPayoutSummary(
    fund.id,
    fund.citizenPayApiKeyId,
    fund.citizenPayApiKeyEnc,
    id,
  );
  if (!payout) notFound();

  // Ponto needs an https post-sign redirect to mint the signing link, so we
  // build it off the treasury's canonical domain (always https) → a public
  // "you can close this tab" page.
  const signedRedirectUrl = `https://${fund.domain}/payout-signed`;
  const live = await getPayoutLiveStatus(
    fund.id,
    fund.citizenPayApiKeyId,
    fund.citizenPayApiKeyEnc,
    id,
    signedRedirectUrl,
  );
  const liveStatus = live?.status ?? payout.status;
  // The signing URL comes from /status while payment-pending. Render it to a
  // QR here (server-side) so the operator can scan to sign on a phone.
  const signingUrl = live?.signingUrl ?? null;
  const signingQr = signingUrl
    ? await QRCode.toDataURL(signingUrl, { margin: 1, width: 220 })
    : null;

  // The "Pay merchant" step initiates a bank transfer, so it needs the
  // treasury's bank connection to have payment initiation enabled.
  const banking = await getBankingStatus(
    fund.id,
    fund.citizenPayApiKeyId,
    fund.citizenPayApiKeyEnc,
  );

  const backTab = payout.status === "complete" ? "completed" : "pending";

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={{ pathname: "/payments", query: { tab: backTab } }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("detail.back")}
        </Link>
      </div>

      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {payout.placeImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={payout.placeImage}
                alt=""
                className="size-11 shrink-0 rounded-full bg-muted object-cover ring-1 ring-foreground/10"
              />
            ) : (
              <span className="size-11 shrink-0 rounded-full bg-muted ring-1 ring-foreground/10" />
            )}
            <div className="space-y-1">
              <h1 className="font-heading text-2xl font-medium">
                {payout.placeName ?? t("detail.untitled")}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  {periodLabel(format, payout)}
                </p>
                {/* Relabelling only — the orders are already claimed, so this
                    moves no money. Pending-gated like every other edit here. */}
                {liveStatus === "pending" && (
                  <PayoutPeriodDialog
                    payoutId={payout.id}
                    startDate={payout.startDate}
                    endDate={payout.endDate}
                  />
                )}
              </div>
            </div>
          </div>
          <Badge variant={STATUS_VARIANT[liveStatus]}>
            {t(`statuses.${liveStatus}`)}
          </Badge>
        </div>

        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={t("total")} value={euro(format, payout.totalAmount)} />
          <Stat label={t("fees")} value={euro(format, payout.totalFees)} />
          <Stat label={t("net")} value={euro(format, payout.net)} emphasis />
          <Suspense fallback={<StatSkeleton label={t("placeBalance")} />}>
            <PlaceBalanceStat
              fundId={fund.id}
              citizenPayApiKeyId={fund.citizenPayApiKeyId}
              citizenPayApiKeyEnc={fund.citizenPayApiKeyEnc}
              placeId={payout.placeId}
              required={payout.totalAmount}
              symbol={fund.tokenSymbol}
              tokenAddress={fund.tokenAddress}
              tokenChainId={fund.tokenChainId}
              tokenDecimals={fund.tokenDecimals}
            />
          </Suspense>
        </dl>

        {/* Manual deduction — a ledger adjustment lowering the net paid out.
            Editable only while pending (CP's gate); shown read-only once
            settlement has started, and hidden when there's nothing to show. */}
        {(liveStatus === "pending" || Number(payout.manualDeduction) > 0) && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2">
            <div className="text-sm">
              <span className="text-muted-foreground">
                {t("manualDeduction")}:{" "}
              </span>
              <span className="font-medium tabular-nums">
                {euro(format, payout.manualDeduction)}
              </span>
              {payout.manualDeductionComment && (
                <span className="text-muted-foreground">
                  {" "}
                  — {payout.manualDeductionComment}
                </span>
              )}
            </div>
            {liveStatus === "pending" && (
              <ManualDeductionDialog
                payoutId={payout.id}
                amount={payout.manualDeduction}
                comment={payout.manualDeductionComment}
                total={payout.totalAmount}
                fees={payout.totalFees}
              />
            )}
          </div>
        )}
      </header>

      <PayoutProcess
        payoutId={payout.id}
        status={liveStatus}
        canInitiatePayment={banking.paymentInitiationEnabled}
        signingUrl={signingUrl}
        signingQr={signingQr}
        feeTransferPending={live?.feeTransferPending ?? payout.feeTransferPending}
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-heading text-lg font-medium">
            {t("orders.title")}
          </h2>
          {/* Adding orders (existing or manual) is only meaningful before
              settlement runs. */}
          {liveStatus === "pending" && (
            <div className="flex items-center gap-2">
              <AddOrdersDialog payoutId={id} />
              <CreateOrderDialog payoutId={id} />
            </div>
          )}
        </div>
        <Suspense fallback={<OrdersSkeleton />}>
          <OrdersPanel
            fundId={fund.id}
            citizenPayApiKeyId={fund.citizenPayApiKeyId}
            citizenPayApiKeyEnc={fund.citizenPayApiKeyEnc}
            payoutId={id}
            symbol={fund.tokenSymbol}
            // Reconcile (fix/archive) and the per-order on-chain re-check only
            // matter while the payout is fully pending. The moment settlement
            // starts (payment-pending / burnt / complete) the orders are locked
            // in — skip verification and treat them all as confirmed.
            reconcilable={liveStatus === "pending"}
            settled={liveStatus !== "pending"}
          />
        </Suspense>
      </section>
    </div>
  );
}

// Server: fetch the full order list (fast, bounded) and hand off to the
// client explorer, which verifies each hash on-chain progressively. Keeping
// the receipt checks off the server render is what removes the long blocking
// skeleton.
async function OrdersPanel({
  fundId,
  citizenPayApiKeyId,
  citizenPayApiKeyEnc,
  payoutId,
  symbol,
  reconcilable,
  settled,
}: {
  fundId: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
  payoutId: string;
  symbol: string | null;
  reconcilable: boolean;
  settled: boolean;
}) {
  const t = await getTranslations("fund.payments.settlement");
  const { orders, placeAccountAddress, truncated, error } =
    await getAllPayoutOrders(
      fundId,
      citizenPayApiKeyId,
      citizenPayApiKeyEnc,
      payoutId,
    );

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t("orders.loadError")}</AlertDescription>
        </Alert>
      )}
      {truncated && (
        <p className="text-xs text-muted-foreground">{t("orders.truncated")}</p>
      )}
      <OrdersExplorer
        orders={orders}
        placeAccount={placeAccountAddress}
        symbol={symbol}
        reconcilable={reconcilable}
        settled={settled}
        payoutId={payoutId}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 font-medium tabular-nums",
          emphasis ? "text-lg" : "text-sm",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

// The place's live on-chain balance vs what settling this payout takes out of
// that account — green when it holds enough, amber when it's short.
//
// `required` is the payout TOTAL, not the net: settlement removes the net (the
// burn) *and* the retained cut (the sweep of fees + manual deduction), and
// net + fees + deduction === total. Comparing against the net alone reads green
// on a payout whose burn succeeds and whose sweep then fails with a 402, which
// is how a payout ends up burnt with its cut still stranded in the merchant's
// account.
//
// Caveat this can't express: the balance is the place's whole wallet, not a
// per-payout pot. A place with two pending payouts needs the sum of both, so
// green here is necessary, not sufficient.
async function PlaceBalanceStat({
  fundId,
  citizenPayApiKeyId,
  citizenPayApiKeyEnc,
  placeId,
  required,
  symbol,
  tokenAddress,
  tokenChainId,
  tokenDecimals,
}: {
  fundId: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
  placeId: string;
  required: string;
  symbol: string | null;
  tokenAddress: string | null;
  tokenChainId: number | null;
  tokenDecimals: number | null;
}) {
  const t = await getTranslations("fund.payments.settlement");
  const balance = await getPlaceOnChainBalance(
    fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
    placeId,
    tokenAddress,
    tokenChainId,
    tokenDecimals,
  );

  if (balance == null) {
    return (
      <div className="rounded-lg border border-border p-3">
        <dt className="text-xs text-muted-foreground">{t("placeBalance")}</dt>
        <dd className="mt-1 text-sm font-medium text-muted-foreground">—</dd>
      </div>
    );
  }

  const enough = Number(balance) >= Number(required);
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-xs text-muted-foreground">{t("placeBalance")}</dt>
      <dd
        className={cn(
          "mt-1 text-sm font-medium tabular-nums",
          enough ? "text-success" : "text-warning",
        )}
      >
        {symbol ? `${balance} ${symbol}` : balance}
      </dd>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {enough ? t("placeBalanceEnough") : t("placeBalanceLow")}
      </p>
    </div>
  );
}

function StatSkeleton({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1">
        <span className="inline-block h-4 w-20 animate-pulse rounded bg-muted" />
      </dd>
    </div>
  );
}

function OrdersSkeleton() {
  return (
    <div className="space-y-3">
      <span className="inline-block h-7 w-48 animate-pulse rounded-lg bg-muted" />
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: 5 }).map((_, i) => (
              <TableHead key={i} className={i === 4 ? "text-right" : undefined}>
                <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-muted" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 8 }).map((_, r) => (
            <TableRow key={r}>
              {Array.from({ length: 5 }).map((_, i) => (
                <TableCell key={i} className={i === 4 ? "text-right" : undefined}>
                  <span
                    className={cn(
                      "inline-block h-3.5 animate-pulse rounded bg-muted",
                      i === 4 ? "w-16" : "w-24",
                    )}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function periodLabel(
  format: Awaited<ReturnType<typeof getFormatter>>,
  p: Payout,
): string {
  const start = format.dateTime(new Date(p.startDate), { dateStyle: "medium" });
  const end = format.dateTime(new Date(p.endDate), { dateStyle: "medium" });
  return `${start} – ${end}`;
}

function euro(
  format: Awaited<ReturnType<typeof getFormatter>>,
  decimal: string,
): string {
  return format.number(Number(decimal), { style: "currency", currency: "EUR" });
}
