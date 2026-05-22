// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatTokenAmount } from "@/services/alchemy/format";
import { getTotalSupply } from "@/services/alchemy/supply";

// Async server component that fetches `totalSupply()` for the token and
// renders an inline label like "Supply: 1,234 ABC". Mounted inside a
// <Suspense> in page.tsx so a slow RPC call doesn't block the shell.
//
// Failure mode: log + render nothing. The supply is a nice-to-have header
// decoration, not a load-bearing piece of data.

export async function TotalSupplyBadge({
  contractAddress,
  chainId,
  decimals,
  symbol,
  label,
}: {
  contractAddress: string;
  chainId: number;
  decimals: number;
  symbol: string | null;
  label: string;
}) {
  let rawSupply: string;
  try {
    rawSupply = await getTotalSupply(chainId, contractAddress);
  } catch (e) {
    console.warn("[token-explorer] totalSupply fetch failed", e);
    return null;
  }

  return (
    <span className="text-muted-foreground">
      {label}{" "}
      <span className="font-medium tabular-nums text-foreground">
        {formatTokenAmount(rawSupply, decimals)}
      </span>
      {symbol && <span className="ml-1">{symbol}</span>}
    </span>
  );
}
