// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFormatter, getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PAYOUT_EXPORT_COLUMNS,
  PAYOUT_EXPORT_PRESETS,
  resolvePayoutExportPreset,
  selectPayoutsForExport,
  summarizePayoutsByMerchant,
} from "@/services/payout/export";
import { fromCents, toCents } from "@/services/payout/money";
import { PAYOUT_ORDER_EXPORT_COLUMNS } from "@/services/payout/order-export";

import { getCompletedPayouts, getPendingPayouts } from "./data";
import { PayoutExportForm } from "./export-form";

// Payments → Payouts → Export: the accountant's recap. Pick a period, see what
// falls in it broken down per merchant ("par tiers"), download the CSV.
//
// Reuses the two cached list loaders the Pending/Completed tabs already use, so
// switching tabs costs no extra CitizenPay round-trip within a render. The
// filtering and the roll-up are the same pure functions the download route
// runs, which is what guarantees the preview and the file agree.
export async function ExportView({
  fundId,
  citizenPayApiKeyId,
  citizenPayApiKeyEnc,
  from,
  to,
}: {
  fundId: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
  from: string;
  to: string;
}) {
  const t = await getTranslations("fund.payments.export");
  const tSettlement = await getTranslations("fund.payments.settlement");
  const format = await getFormatter();

  const [pendingData, completedData] = await Promise.all([
    getPendingPayouts(fundId, citizenPayApiKeyId, citizenPayApiKeyEnc),
    getCompletedPayouts(fundId, citizenPayApiKeyId, citizenPayApiKeyEnc),
  ]);
  const error = pendingData.error || completedData.error;

  const selected = selectPayoutsForExport(
    [...pendingData.payouts, ...completedData.payouts],
    { from, to },
  );
  const byMerchant = summarizePayoutsByMerchant(selected);
  const netTotal = fromCents(
    selected.reduce((sum, p) => sum + toCents(p.net), 0),
  );

  const presets = PAYOUT_EXPORT_PRESETS.map((key) => ({
    key,
    label: t(`presets.${key}`),
    ...resolvePayoutExportPreset(key),
  }));

  return (
    <div className="space-y-5">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{tSettlement("loadError")}</AlertDescription>
        </Alert>
      )}

      <p className="text-xs text-muted-foreground">{t("description")}</p>

      <PayoutExportForm
        from={from}
        to={to}
        count={selected.length}
        presets={presets}
      />

      <p className="text-sm">
        {t("summary", { count: selected.length, net: euro(format, netTotal) })}
      </p>

      <div className="space-y-2">
        <h2 className="text-sm font-medium">{t("byMerchant")}</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tSettlement("place")}</TableHead>
              <TableHead className="text-right">{t("payoutCount")}</TableHead>
              <TableHead className="text-right">
                {tSettlement("total")}
              </TableHead>
              <TableHead className="text-right text-xs font-normal">
                {tSettlement("processorFees")}
              </TableHead>
              <TableHead className="text-right text-xs font-normal">
                {tSettlement("platformFee")}
              </TableHead>
              <TableHead className="text-right">{tSettlement("net")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byMerchant.length === 0 ? (
              <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
            ) : (
              byMerchant.map((m) => (
                <TableRow key={m.placeId}>
                  <TableCell className="text-sm">{m.merchant ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.payoutCount}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                    {euro(format, m.gross)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                    {euro(format, m.processorFees)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                    {euro(format, m.platformFee)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {euro(format, m.net)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Spell out each file's columns: the accountant asked for a specific set
          of fields, and knowing they're all there saves a download. Two files
          come out of this window — the recap (one row per payout) and the
          transaction detail (one row per order inside those payouts) — so each
          gets its own line rather than one merged list. */}
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          <span className="font-medium">{t("downloadRecap")}</span> —{" "}
          {t("recapHint")}{" "}
          {t("columnsHint", {
            columns: PAYOUT_EXPORT_COLUMNS.map((c) => t(`columns.${c}`)).join(", "),
          })}
        </p>
        <p>
          <span className="font-medium">{t("downloadDetail")}</span> —{" "}
          {t("detailHint")}{" "}
          {t("columnsHint", {
            columns: PAYOUT_ORDER_EXPORT_COLUMNS.map((c) =>
              t(`orderColumns.${c}`),
            ).join(", "),
          })}
        </p>
      </div>
    </div>
  );
}

function euro(
  format: Awaited<ReturnType<typeof getFormatter>>,
  decimal: string,
): string {
  return format.number(Number(decimal), { style: "currency", currency: "EUR" });
}
