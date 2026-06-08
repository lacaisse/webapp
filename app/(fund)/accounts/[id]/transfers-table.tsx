// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TxAnnotationCell } from "@/components/tx-annotation";
import { shortAddress } from "@/services/alchemy/format";
import { getAccountTransfersAction } from "@/services/token-account/admin-actions";
import type { AccountTransfer } from "@/services/token-account/transfers";

export function TransfersTable({
  id,
  initial,
  initialCursor,
  symbol,
  accountNames,
}: {
  id: string;
  initial: AccountTransfer[];
  initialCursor: string | null;
  symbol: string | null;
  // lowercased address → fund-account name, for labelling the counterparty.
  accountNames: Record<string, string>;
}) {
  const t = useTranslations("fund.accounts.transfers");
  const format = useFormatter();
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, startLoad] = useTransition();

  const loadMore = () => {
    if (!cursor) return;
    startLoad(async () => {
      const res = await getAccountTransfersAction({ id, cursor });
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
            <TableHead>{t("date")}</TableHead>
            <TableHead className="text-right">{t("amount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((tr) => {
            const counterparty = tr.direction === "out" ? tr.to : tr.from;
            const counterpartyName = accountNames[counterparty.toLowerCase()];
            const sign =
              tr.direction === "out" ? "−" : tr.direction === "in" ? "+" : "";
            return (
              <TableRow key={tr.uniqueId}>
                <TableCell>{t(`directions.${tr.direction}`)}</TableCell>
                <TableCell className="text-xs">
                  {counterpartyName ? (
                    <span>{counterpartyName}</span>
                  ) : (
                    <span className="font-mono text-muted-foreground">
                      {shortAddress(counterparty)}
                    </span>
                  )}
                  <TxAnnotationCell
                    txHash={tr.hash}
                    kind={tr.annotation?.kind ?? null}
                    note={tr.annotation?.note ?? null}
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
                  {symbol ? ` ${symbol}` : ""}
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
