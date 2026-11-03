// SPDX-License-Identifier: AGPL-3.0-or-later
import { AlertTriangle, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import type { SafeTxSummary } from "@/services/safe/types";
import { explorerAddressUrl } from "@/services/safe/config";

import {
  conversionExpired,
  formatNative,
  thresholdChange,
  thresholdDeltaLabel,
  transferContract,
  weakensSafe,
  type SafesT,
} from "../format";
import { SafeAddress } from "../safe-address";

// What a Safe transaction actually does, spelled out for the people asked to
// sign it: full addresses (copy + explorer), amount and token contract, the
// threshold before → after, and warnings when an address is unknown to the
// fund or the change weakens the Safe. The summary line alone shows labels a
// proposer chose; this block shows what the signature commits to.
//
// Hook-free (takes a `fund.safes` translator) so it renders inside client
// cards and dialogs alike.
export function TxDetails({
  summary,
  chainId,
  tokenSymbol,
  names,
  safeWalletTxHref,
  t,
}: {
  summary: SafeTxSummary | null;
  chainId: number;
  tokenSymbol: string | null;
  // lowercased address → name of every address the fund knows (owners,
  // members' signer keys, accounts, staff cards)
  names: Record<string, string>;
  safeWalletTxHref: string | null;
  t: SafesT;
}) {
  const rows: { key: string; label: string; value: ReactNode }[] = [];
  const known = (address: string) => Boolean(names[address.toLowerCase()]);
  const address = (value: string, flagUnknown: boolean) => (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <SafeAddress
        address={value}
        href={explorerAddressUrl(chainId, value)}
        linkLabel={t("tx.details.viewOnExplorer")}
        full
        className="min-w-0"
      />
      {flagUnknown && !known(value) && (
        <Badge variant="warning">
          <AlertTriangle />
          {t("tx.details.unknownAddress")}
        </Badge>
      )}
    </span>
  );

  if (summary?.kind === "TOKEN_TRANSFER") {
    const symbol = summary.symbol?.trim() || tokenSymbol;
    rows.push({
      key: "recipient",
      label: t("tx.details.recipient"),
      value: address(summary.recipient, true),
    });
    rows.push({
      key: "amount",
      label: t("tx.details.amount"),
      value: (
        <span className="font-medium tabular-nums">
          {symbol ? `${summary.amount} ${symbol}` : summary.amount}
        </span>
      ),
    });
    const contract = transferContract(summary);
    if (contract) {
      rows.push({
        key: "contract",
        label: t("tx.details.tokenContract"),
        value: address(contract, false),
      });
    }
  } else if (summary?.kind === "ADD_OWNER") {
    rows.push({
      key: "owner",
      label: t("tx.details.newOwner"),
      value: address(summary.owner, true),
    });
  } else if (summary?.kind === "REMOVE_OWNER") {
    rows.push({
      key: "owner",
      label: t("tx.details.removedOwner"),
      value: address(summary.owner, false),
    });
  } else if (summary?.kind === "SWAP_OWNER") {
    rows.push({
      key: "old",
      label: t("tx.details.removedOwner"),
      value: address(summary.oldOwner, false),
    });
    rows.push({
      key: "new",
      label: t("tx.details.newOwner"),
      value: address(summary.newOwner, true),
    });
  } else if (summary?.kind === "CONVERSION") {
    // What the conversion as a whole does, then every inner call of this
    // step with the contract it targets — a batch is signed as one.
    rows.push({
      key: "conversion",
      label: t("tx.details.conversion"),
      value: (
        <span className="font-medium tabular-nums">
          {`${summary.from.amount} ${summary.from.symbol} → ≥ ${summary.to.minAmount} ${summary.to.symbol}`}
        </span>
      ),
    });
    if (summary.steps > 1) {
      rows.push({
        key: "step",
        label: t("tx.details.step"),
        value: `${summary.step} / ${summary.steps} · ${t(`conversion.steps.${summary.label}`)}`,
      });
    }
    if (typeof summary.validUntil === "string") {
      rows.push({
        key: "validUntil",
        label: t("tx.details.validUntil"),
        value: (
          <span className="flex flex-wrap items-center gap-1.5">
            <time dateTime={summary.validUntil}>{summary.validUntil.slice(0, 10)}</time>
            {conversionExpired(summary) && (
              <Badge variant="destructive">
                <AlertTriangle />
                {t("tx.details.orderExpired")}
              </Badge>
            )}
          </span>
        ),
      });
    }
    const calls = Array.isArray(summary.calls) ? summary.calls : [];
    calls.forEach((call, i) => {
      rows.push({
        key: `call-${i}`,
        label: `${i + 1}. ${t(`conversion.calls.${call.label}`)}`,
        value: (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {address(call.to, false)}
            {typeof call.value === "string" && call.value !== "0" && (
              <span className="text-muted-foreground tabular-nums">
                {`${formatNative(call.value)} xDAI`}
              </span>
            )}
          </span>
        ),
      });
    });
  }

  const change = thresholdChange(summary);
  if (change) {
    rows.push({
      key: "threshold",
      label: t("tx.details.threshold"),
      value: (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium tabular-nums">{thresholdDeltaLabel(change)}</span>
          {weakensSafe(change) && (
            <Badge variant="destructive">
              <AlertTriangle />
              {t("tx.details.weakens")}
            </Badge>
          )}
        </span>
      ),
    });
  }

  if (rows.length === 0 && !safeWalletTxHref) return null;

  return (
    <div className="space-y-1.5 rounded-lg bg-muted/40 px-3 py-2 text-xs">
      {rows.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {safeWalletTxHref && (
        <a
          href={safeWalletTxHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 font-medium text-muted-foreground underline underline-offset-3 hover:text-foreground"
        >
          {t("openInSafeWallet")}
          <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}
