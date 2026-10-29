// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Sensitive } from "@/components/privacy/sensitive";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TxAnnotationCell, TxTriggerCell } from "@/components/tx-annotation";
import { shortAddress } from "@/services/alchemy/format";
import type { AccountTransfer } from "@/services/token-account/transfers";

// What a "load more" call returns: the shape of getAccountTransfersAction and
// getSafeTransfersAction alike.
export type TransfersPageResult =
  | { error: string }
  | { ok: true; transfers: AccountTransfer[]; nextCursor: string | null };

// One account's on-chain history (a named account or a Safe). The caller
// supplies the paging call, so each page wires its own server action.
export function TransfersTable({
  initial,
  initialCursor,
  symbol,
  accountNames,
  loadMore: fetchPage,
}: {
  initial: AccountTransfer[];
  initialCursor: string | null;
  // Fallback symbol; a row's own `symbol` (mixed-asset pages) wins.
  symbol: string | null;
  // lowercased address → fund-account name, for labelling the counterparty.
  accountNames: Record<string, string>;
  loadMore: (cursor: string) => Promise<TransfersPageResult>;
}) {
  const t = useTranslations("fund.accounts.transfers");
  const format = useFormatter();
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, startLoad] = useTransition();

  const loadMore = () => {
    if (!cursor) return;
    startLoad(async () => {
      const res = await fetchPage(cursor);
      if ("error" in res) return;
      setRows((prev) => [...prev, ...res.transfers]);
      setCursor(res.nextCursor);
    });
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border py-10 text-center text-sm text-muted-foreground">
        {t("empty")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("direction")}</TableHead>
            <TableHead>{t("counterparty")}</TableHead>
            <TableHead>{t("trigger")}</TableHead>
            <TableHead>{t("date")}</TableHead>
            <TableHead className="text-right">{t("amount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((tr) => {
            const counterparty = tr.direction === "out" ? tr.to : tr.from;
            const counterpartyName = accountNames[counterparty.toLowerCase()];
            const rowSymbol = tr.symbol ?? symbol;
            const sign =
              tr.direction === "out" ? "−" : tr.direction === "in" ? "+" : "";
            return (
              <TableRow key={tr.uniqueId}>
                <TableCell>{t(`directions.${tr.direction}`)}</TableCell>
                <TableCell className="text-xs">
                  {counterpartyName ? (
                    // Only the fund's own named token accounts resolve to a
                    // name here — fund-level, never masked.
                    <span>{counterpartyName}</span>
                  ) : (
                    // Anything else is a bare address: a member card, a
                    // place or an outside wallet. The row carries no kind to
                    // tell them apart, so privacy mode masks them all.
                    <span className="font-mono text-muted-foreground">
                      <Sensitive kind="address">
                        {shortAddress(counterparty)}
                      </Sensitive>
                    </span>
                  )}
                  <TxAnnotationCell
                    txHash={tr.hash}
                    kind={tr.annotation?.kind ?? null}
                    note={tr.annotation?.note ?? null}
                  />
                </TableCell>
                <TableCell>
                  <TxTriggerCell
                    trigger={tr.annotation?.trigger ?? null}
                    triggeredBy={tr.annotation?.triggeredByName ?? null}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {tr.timestamp
                    ? format.dateTime(new Date(tr.timestamp), {
                        dateStyle: "medium",
                      })
                    : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {sign}
                  {tr.value}
                  {rowSymbol ? ` ${rowSymbol}` : ""}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {cursor && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={loading}
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
