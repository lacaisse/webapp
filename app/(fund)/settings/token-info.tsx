// SPDX-License-Identifier: AGPL-3.0-or-later
import { CheckCircle2, Coins, HelpCircle, XCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { CopyButton } from "@/components/copy-button";
import { checkMinterRole, type RoleStatus } from "@/services/token/permissions";

// Read-only display of the connected token. All fields are cached from
// CitizenPay (synced by services/citizenpay/sync.ts during the connect
// callback). Editing is intentionally not exposed — the token is owned
// by the CitizenPay treasury and we'd silently diverge from CP's truth
// if we let admins type values here.
//
// The "Minter" block surfaces the per-fund signing EOA derived from
// services/token/minter.ts. The smart-account address column stays empty
// until CitizenPay's bundler factory + salt convention are wired.
// "Mint permission" reads `hasRole(MINTER_ROLE, smartAccount)` on-chain
// via Alchemy — see services/token/permissions.ts.

// Display label for known chains. Anything not in this list shows the raw
// chain id — fine as a fallback because the column accepts arbitrary ints.
const CHAIN_LABELS: Record<number, string> = {
  100: "Gnosis",
  137: "Polygon",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  1: "Ethereum",
};

export async function TokenInfo({
  token,
  minter,
  connected,
}: {
  token: {
    address: string | null;
    chainId: number | null;
    decimals: number | null;
    name: string | null;
    symbol: string | null;
    logoUrl: string | null;
  };
  minter: {
    eoaAddress: string | null;
    smartAccountAddress: string | null;
  };
  connected: boolean;
}) {
  const t = await getTranslations("fund.settings.token");
  const hasAny =
    token.address ||
    token.name ||
    token.symbol ||
    token.decimals != null ||
    token.logoUrl;

  const chainLabel =
    token.chainId != null
      ? (CHAIN_LABELS[token.chainId] ?? `#${token.chainId}`)
      : null;

  // On-chain MINTER_ROLE check — only fire when both ends are known, else
  // we'd be calling hasRole(MINTER_ROLE, 0x0) which is meaningless.
  const minterRole: RoleStatus | null =
    token.address && token.chainId != null && minter.smartAccountAddress
      ? await checkMinterRole({
          tokenAddress: token.address,
          chainId: token.chainId,
          account: minter.smartAccountAddress,
        })
      : null;

  return (
    <div className="space-y-6">
      {hasAny ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {token.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={token.logoUrl}
                alt={token.name ? `${token.name} logo` : "Token logo"}
                className="size-10 rounded-full bg-muted object-contain ring-1 ring-foreground/10"
              />
            ) : (
              <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Coins className="size-5" />
              </div>
            )}
            <div>
              <div className="text-base font-medium">{token.name ?? "—"}</div>
              {token.symbol && (
                <div className="font-mono text-xs text-muted-foreground">
                  {token.symbol}
                </div>
              )}
            </div>
          </div>

          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t("addressLabel")}</dt>
            <dd className="font-mono break-all">{token.address ?? "—"}</dd>

            <dt className="text-muted-foreground">{t("chainLabel")}</dt>
            <dd>{chainLabel ?? "—"}</dd>

            <dt className="text-muted-foreground">{t("decimalsLabel")}</dt>
            <dd>{token.decimals ?? "—"}</dd>
          </dl>

          <p className="text-xs text-muted-foreground">{t("readOnlyHint")}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
          {connected ? t("notSyncedYet") : t("notConnected")}
        </div>
      )}

      <div className="space-y-3 border-t pt-6">
        <div>
          <h3 className="text-sm font-medium">{t("minter.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("minter.description")}
          </p>
        </div>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{t("minter.eoaLabel")}</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            {minter.eoaAddress ? (
              <>
                <span className="font-mono break-all">{minter.eoaAddress}</span>
                <CopyButton value={minter.eoaAddress} />
              </>
            ) : (
              <span className="text-muted-foreground italic">
                {t("minter.notProvisioned")}
              </span>
            )}
          </dd>

          <dt className="text-muted-foreground">
            {t("minter.smartAccountLabel")}
          </dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            {minter.smartAccountAddress ? (
              <>
                <span className="font-mono break-all">
                  {minter.smartAccountAddress}
                </span>
                <CopyButton value={minter.smartAccountAddress} />
              </>
            ) : (
              <span className="text-muted-foreground italic">
                {t("minter.smartAccountPending")}
              </span>
            )}
          </dd>

          {minterRole && (
            <>
              <dt className="text-muted-foreground">
                {t("minter.permissionLabel")}
              </dt>
              <dd>
                <MinterRoleBadge
                  status={minterRole}
                  granted={t("minter.permissionGranted")}
                  missing={t("minter.permissionMissing")}
                  unknown={t("minter.permissionUnknown")}
                />
              </dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

function MinterRoleBadge({
  status,
  granted,
  missing,
  unknown,
}: {
  status: RoleStatus;
  granted: string;
  missing: string;
  unknown: string;
}) {
  if (status === "has-role") {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-600">
        <CheckCircle2 className="size-4" />
        {granted}
      </span>
    );
  }
  if (status === "missing-role") {
    return (
      <span className="inline-flex items-center gap-1.5 text-destructive">
        <XCircle className="size-4" />
        {missing}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <HelpCircle className="size-4" />
      {unknown}
    </span>
  );
}
