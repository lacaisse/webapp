// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Payout } from "@/services/citizenpay/types";

import { CreatePayoutDialog } from "./create-payout-dialog";
import {
  getCompletedPayouts,
  getPayoutDrafts,
  getPendingPayouts,
} from "./data";

type Creds = {
  fundId: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

// =============================================================================
// Drafts — unpaid orders grouped by place, ready to roll into a payout
// =============================================================================

export async function DraftsView({
  fundId,
  citizenPayApiKeyId,
  citizenPayApiKeyEnc,
}: Creds) {
  const t = await getTranslations("fund.payments.settlement");
  const format = await getFormatter();
  const { drafts, error } = await getPayoutDrafts(
    fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
  );

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t("loadError")}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">{t("drafts.description")}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("place")}</TableHead>
            <TableHead className="text-right">{t("orderCount")}</TableHead>
            <TableHead className="text-right">{t("total")}</TableHead>
            <TableHead className="text-right">{t("fees")}</TableHead>
            <TableHead className="text-right">{t("net")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {drafts.length === 0 ? (
            <TableEmpty colSpan={6}>{t("drafts.empty")}</TableEmpty>
          ) : (
            drafts.map((d) => (
              <TableRow key={d.placeId}>
                <TableCell>
                  <PlaceCell name={d.placeName} image={d.placeImage} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {d.orderCount}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {euro(format, d.total)}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {euro(format, d.fees)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {euro(format, d.net)}
                </TableCell>
                <TableCell className="text-right">
                  <CreatePayoutDialog
                    placeId={d.placeId}
                    placeName={d.placeName}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// =============================================================================
// Pending — materialised payouts awaiting settlement (burn + bank payment)
// =============================================================================

export async function PendingPayoutsView({
  fundId,
  citizenPayApiKeyId,
  citizenPayApiKeyEnc,
}: Creds) {
  const t = await getTranslations("fund.payments.settlement");
  const format = await getFormatter();
  const { payouts, error } = await getPendingPayouts(
    fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
  );

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t("loadError")}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">{t("pending.description")}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("period")}</TableHead>
            <TableHead>{t("place")}</TableHead>
            <TableHead className="text-right">{t("fees")}</TableHead>
            <TableHead className="text-right">{t("net")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {payouts.length === 0 ? (
            <TableEmpty colSpan={5}>{t("pending.empty")}</TableEmpty>
          ) : (
            payouts.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {period(format, p)}
                </TableCell>
                <TableCell>
                  <PlaceCell name={p.placeName} image={p.placeImage} />
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {euro(format, p.totalFees)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {euro(format, p.net)}
                </TableCell>
                <TableCell className="text-right">
                  <DetailsLink payoutId={p.id} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// =============================================================================
// Completed — settled payouts (read-only + order review)
// =============================================================================

export async function CompletedPayoutsView({
  fundId,
  citizenPayApiKeyId,
  citizenPayApiKeyEnc,
}: Creds) {
  const t = await getTranslations("fund.payments.settlement");
  const format = await getFormatter();
  const { payouts, error } = await getCompletedPayouts(
    fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
  );

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t("loadError")}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">
        {t("completed.description")}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("period")}</TableHead>
            <TableHead>{t("place")}</TableHead>
            <TableHead className="text-right">{t("total")}</TableHead>
            <TableHead className="text-right">{t("fees")}</TableHead>
            <TableHead className="text-right">{t("net")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {payouts.length === 0 ? (
            <TableEmpty colSpan={6}>{t("completed.empty")}</TableEmpty>
          ) : (
            payouts.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {period(format, p)}
                </TableCell>
                <TableCell>
                  <PlaceCell name={p.placeName} image={p.placeImage} />
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {euro(format, p.totalAmount)}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {euro(format, p.totalFees)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {euro(format, p.net)}
                </TableCell>
                <TableCell className="text-right">
                  <DetailsLink payoutId={p.id} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// =============================================================================
// Shared bits
// =============================================================================

async function DetailsLink({ payoutId }: { payoutId: string }) {
  const t = await getTranslations("fund.payments.settlement");
  return (
    <Link
      href={`/payments/payouts/${payoutId}`}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      {t("details")}
    </Link>
  );
}

function PlaceCell({
  name,
  image,
}: {
  name: string | null;
  image: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          className="size-6 shrink-0 rounded-full bg-muted object-cover ring-1 ring-foreground/10"
        />
      ) : (
        <span className="size-6 shrink-0 rounded-full bg-muted ring-1 ring-foreground/10" />
      )}
      <span className="text-sm">{name ?? "—"}</span>
    </div>
  );
}

function period(
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
