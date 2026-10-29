// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExternalLink } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import type { FundSafeTxStatus } from "@/services/db/generated/enums";
import { explorerTxUrl } from "@/services/safe/config";

import type { SafeTxView } from "../data";
import { shortAddress, summaryLine } from "../format";
import { TxKindIcon } from "./tx-kind-icon";

const STATUS_VARIANT: Record<
  FundSafeTxStatus,
  "success" | "destructive" | "default" | "warning" | "info"
> = {
  EXECUTED: "success",
  FAILED: "destructive",
  SUPERSEDED: "default",
  PENDING: "warning",
  EXECUTING: "info",
};

// Settled transactions, newest first: what happened, when, how it was
// executed, and who signed it.
export async function HistoryList({
  chainId,
  history,
  tokenSymbol,
  names,
}: {
  chainId: number;
  history: SafeTxView[];
  tokenSymbol: string | null;
  // lowercased address → owner display name (current and former owners)
  names: Record<string, string>;
}) {
  const t = await getTranslations("fund.safes");
  const format = await getFormatter();

  if (history.length === 0) {
    return (
      <div className="rounded-lg border border-border py-8 text-center text-sm text-muted-foreground">
        {t("history.empty")}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg ring-1 ring-foreground/10">
      {history.map((tx) => {
        const when = tx.executedAt ?? tx.createdAt;
        const signers = tx.signatures.map(
          (s) =>
            names[s.ownerAddress.toLowerCase()] ??
            s.userName ??
            shortAddress(s.ownerAddress),
        );
        return (
          <li key={tx.id} className="flex items-start gap-3 px-3 py-2.5">
            <TxKindIcon kind={tx.kind} className="size-7" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">
                  {summaryLine(tx.summary, t, tokenSymbol, { names, kind: tx.kind })}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {t("tx.nonce", { nonce: tx.nonce })}
                </span>
                <Badge variant={STATUS_VARIANT[tx.status]}>
                  {t(`tx.status.${tx.status}`)}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <time dateTime={when}>
                  {format.dateTime(new Date(when), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
                {tx.status === "EXECUTED" && tx.executedBy && (
                  <span>
                    {tx.executedBy === "external"
                      ? t("tx.executedBy.external")
                      : t("tx.executedBy.relayer")}
                  </span>
                )}
                {tx.txHash && (
                  <a
                    href={explorerTxUrl(chainId, tx.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-mono hover:text-foreground"
                  >
                    {shortAddress(tx.txHash)}
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
              {signers.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("tx.signedBy", { names: format.list(signers) })}
                </p>
              )}
              {tx.note && (
                <p className="text-xs text-muted-foreground italic">“{tx.note}”</p>
              )}
              {tx.status === "FAILED" && tx.errorMessage && (
                <p className="text-xs break-words text-destructive">{tx.errorMessage}</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
