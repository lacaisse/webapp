// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { Fuel, Info } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { shortAddress } from "@/services/alchemy/format";
import { requireFundRole, requireUser } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";
import { explorerAddressUrl, safeWalletUrl } from "@/services/safe/config";

import { CreateAccountDialog } from "./create-account-dialog";
import { getTokenAccounts } from "./data";
import { getEligibleMembers, getRelayerStatus, getSafes } from "./safes/data";
import { formatNative, isDeployedAddress, thresholdLabel } from "./safes/format";
import { RetryDeployButton } from "./safes/retry-deploy-button";
import { SafeAddress } from "./safes/safe-address";
import { SafeStatusBadge } from "./safes/status-badge";
import { AccountsTableSkeleton } from "./skeleton";

// Safe actions invoked from this route (create, retry deployment) broadcast a
// transaction and wait for its receipt (relayer.ts, up to 90 s); give them
// room on Vercel.
export const maxDuration = 120;

// Safes default to Gnosis; the fund token's chain wins when it's known.
const DEFAULT_CHAIN_ID = 100;

// Synchronous shell: the header (with its create CTA) and the balance table
// (Alchemy-backed, slow) each stream behind their own <Suspense>.
export default async function AccountsPage() {
  await requireFundRole("ADMIN");
  return (
    <div className="space-y-6">
      <Suspense fallback={<AccountsHeaderFallback />}>
        <AccountsHeader />
      </Suspense>
      <Suspense fallback={<AccountsTableSkeleton />}>
        <AccountsTable />
      </Suspense>
    </div>
  );
}

async function AccountsHeader() {
  const t = await getTranslations("fund.accounts");
  const tSafes = await getTranslations("fund.safes");
  const [user, fund] = await Promise.all([requireUser(), requireCurrentFund()]);
  const chainId = fund.tokenChainId ?? DEFAULT_CHAIN_ID;
  const relayer = await getRelayerStatus(chainId);

  // A fund-key account is derived from the minter EOA + CP's Safe factory;
  // a Safe needs the fund token (it holds it) and the platform relayer.
  const canCreateAccount = Boolean(
    fund.tokenMinterEoaAddress && fund.citizenPayAccountFactoryAddress,
  );
  const canCreateSafe = Boolean(fund.tokenAddress) && relayer.configured;
  const members = canCreateSafe ? await getEligibleMembers(fund.id) : [];

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <CreateAccountDialog
          canCreateAccount={canCreateAccount}
          canCreateSafe={canCreateSafe}
          members={members.map((m) => ({
            userId: m.userId,
            name: m.name,
            email: m.email,
            image: m.image,
          }))}
          currentUserId={user.id}
        />
      </header>

      {!canCreateAccount && !canCreateSafe && (
        <Alert>
          <Info className="size-4" />
          <AlertDescription>{t("notConnected")}</AlertDescription>
        </Alert>
      )}

      {canCreateSafe && relayer.address && (
        // Where a Safe's gas comes from: the relayer EOA and what it has
        // left, so an operator knows which address to top up with xDAI.
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <Fuel className="size-4 shrink-0" />
          <span>
            {tSafes("relayer.status", {
              balance: relayer.balanceWei ? formatNative(relayer.balanceWei) : "—",
            })}
          </span>
          <SafeAddress
            address={relayer.address}
            href={explorerAddressUrl(chainId, relayer.address)}
            full
          />
        </div>
      )}
    </>
  );
}

async function AccountsTable() {
  const t = await getTranslations("fund.accounts");
  const tSafes = await getTranslations("fund.safes");
  const fund = await requireCurrentFund();

  const token = {
    tokenAddress: fund.tokenAddress,
    tokenChainId: fund.tokenChainId,
    tokenDecimals: fund.tokenDecimals,
  };
  const [{ accounts, balancesError }, { safes, balancesError: safesBalancesError }] =
    await Promise.all([getTokenAccounts(fund.id, token), getSafes(fund.id, token)]);

  const formatBalance = (balance: string | null) =>
    balance == null
      ? "—"
      : `${balance}${fund.tokenSymbol ? ` ${fund.tokenSymbol}` : ""}`;

  return (
    <>
      {(balancesError || safesBalancesError) && (
        <Alert variant="warning">
          <AlertDescription>{t("balancesError")}</AlertDescription>
        </Alert>
      )}

      {accounts.length === 0 && safes.length === 0 ? (
        <div className="rounded-lg border border-border py-12 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("table.name")}</TableHead>
              <TableHead>{t("table.address")}</TableHead>
              <TableHead>{t("table.security")}</TableHead>
              <TableHead className="text-right">{t("table.balance")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <Link
                    href={`/accounts/${a.id}`}
                    className="font-medium hover:underline"
                  >
                    {a.name || t("defaultName")}
                  </Link>
                  {a.saltNonce === 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t("defaultBadge")}
                    </span>
                  )}
                  {a.kind === "SOURCE" && (
                    <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t("sourceBadge")}
                    </span>
                  )}
                  {a.kind === "SOURCE" && a.serial && (
                    <div className="font-mono text-xs text-muted-foreground">
                      {a.serial}
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {shortAddress(a.address)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {t("security.fundKey")}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBalance(a.balance)}
                </TableCell>
              </TableRow>
            ))}
            {safes.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link
                    href={`/accounts/safes/${s.id}`}
                    className="font-medium hover:underline"
                  >
                    {s.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {isDeployedAddress(s.address) && s.status === "ACTIVE" ? (
                    <SafeAddress
                      address={s.address}
                      href={safeWalletUrl(s.chainId, s.address)}
                      linkLabel={tSafes("openInSafeWallet")}
                    />
                  ) : (
                    // Not deployed yet: the address column holds a placeholder.
                    <SafeStatusBadge status={s.status} />
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">
                      {t("security.safe", {
                        threshold: thresholdLabel(s.threshold, s.ownerCount, tSafes),
                        m: s.ownerCount,
                      })}
                    </span>
                    {s.pendingCount > 0 && (
                      <Badge variant="warning">
                        {tSafes("table.pendingCount", { count: s.pendingCount })}
                      </Badge>
                    )}
                    {s.status === "FAILED" && <RetryDeployButton safeId={s.id} />}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBalance(s.balance)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function AccountsHeaderFallback() {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-9 w-32" />
    </header>
  );
}
