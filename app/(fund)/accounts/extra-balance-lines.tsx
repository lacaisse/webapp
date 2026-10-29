// SPDX-License-Identifier: AGPL-3.0-or-later
import { cn } from "@/lib/utils";
import type { ExtraToken } from "@/services/token/extra-tokens";

import type { ExtraBalances } from "./extra-balances";
import { isDeployedAddress } from "./safes/format";

type Line = { key: string; symbol: string; amount: string | null };

/**
 * The extra lines for one address: none when nothing is enabled or the
 * address can't hold them (undeployed Safe, Safe on another chain); one line
 * per enabled token otherwise, with a null amount ("—") when the read failed.
 */
export function extraLinesFor(
  address: string,
  tokens: ExtraToken[],
  extra: ExtraBalances,
  eligible = true,
): Line[] {
  if (!eligible || tokens.length === 0 || !isDeployedAddress(address)) return [];
  const found = extra.byAddress.get(address.toLowerCase());
  return tokens.map((tok) => ({
    key: tok.key,
    symbol: tok.symbol,
    amount: found?.find((b) => b.key === tok.key)?.amount ?? null,
  }));
}

/** Muted, smaller lines under a fund-token balance: "12.34 xDAI". */
export function ExtraBalanceLines({
  lines,
  className,
}: {
  lines: Line[];
  className?: string;
}) {
  if (lines.length === 0) return null;
  return (
    <div className={cn("space-y-0.5 text-xs text-muted-foreground tabular-nums", className)}>
      {lines.map((l) => (
        <div key={l.key}>{`${l.amount ?? "—"} ${l.symbol}`}</div>
      ))}
    </div>
  );
}
