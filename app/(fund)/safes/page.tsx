// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { Fuel, Info, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireFundRole, requireUser } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";
import { explorerAddressUrl, safeWalletUrl } from "@/services/safe/config";

import { CreateSafeDialog } from "./create-safe-dialog";
import { getEligibleMembers, getRelayerStatus, getSafes } from "./data";
import { formatNative, isDeployedAddress, thresholdLabel } from "./format";
import { RetryDeployButton } from "./retry-deploy-button";
import { SafeAddress } from "./safe-address";
import { SafesHeaderSkeleton, SafesTableSkeleton } from "./skeleton";
import { SafeStatusBadge } from "./status-badge";

// Server actions invoked from this route broadcast a Safe transaction and wait
// for its receipt (relayer.ts, up to 90 s); give them room on Vercel.
export const maxDuration = 120;

// Safes default to Gnosis; the fund token's chain wins when it's known.
const DEFAULT_CHAIN_ID = 100;

export default async function SafesPage() {
  await requireFundRole("ADMIN");
  return (
    <div className="space-y-6">
      <Suspense fallback={<SafesHeaderSkeleton />}>
        <SafesHeader />
      </Suspense>
      <Suspense fallback={<SafesTableSkeleton />}>
        <SafesTable />
      </Suspense>
    </div>
  );
}

async function SafesHeader() {
  const t = await getTranslations("fund.safes");
  const [user, fund] = await Promise.all([requireUser(), requireCurrentFund()]);
  const chainId = fund.tokenChainId ?? DEFAULT_CHAIN_ID;
  const relayer = await getRelayerStatus(chainId);

  const connected = Boolean(fund.tokenAddress);
  const canCreate = connected && relayer.configured;
  const members = canCreate ? await getEligibleMembers(fund.id) : [];

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        {canCreate && (
          <CreateSafeDialog
            members={members.map((m) => ({
              userId: m.userId,
              name: m.name,
              email: m.email,
              image: m.image,
            }))}
            currentUserId={user.id}
          />
        )}
      </header>

      {!connected ? (
        <Alert>
          <Info className="size-4" />
          <AlertDescription>{t("notConnected")}</AlertDescription>
        </Alert>
      ) : !relayer.configured ? (
        <Alert variant="warning">
          <Info className="size-4" />
          <AlertDescription>{t("relayerMissing")}</AlertDescription>
        </Alert>
      ) : relayer.address ? (
        // Where the gas comes from: the relayer EOA and what it has left, so
        // an operator knows which address to top up with xDAI.
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <Fuel className="size-4 shrink-0" />
          <span>
            {t("relayer.status", {
              balance: relayer.balanceWei ? formatNative(relayer.balanceWei) : "—",
            })}
          </span>
          <SafeAddress
            address={relayer.address}
            href={explorerAddressUrl(chainId, relayer.address)}
            full
          />
        </div>
      ) : null}
    </>
  );
}

async function SafesTable() {
  const t = await getTranslations("fund.safes");
  const fund = await requireCurrentFund();

  const { safes, balancesError } = await getSafes(fund.id, {
    tokenAddress: fund.tokenAddress,
    tokenChainId: fund.tokenChainId,
    tokenDecimals: fund.tokenDecimals,
  });

  if (safes.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted">
            <ShieldCheck className="size-5 text-muted-foreground" />
          </span>
          <div className="space-y-1">
            <div className="font-heading text-base font-medium">
              {t("empty.title")}
            </div>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              {t("empty.body")}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {balancesError && (
        <Alert variant="warning">
          <AlertDescription>{t("balancesError")}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("table.name")}</TableHead>
            <TableHead>{t("table.address")}</TableHead>
            <TableHead>{t("table.owners")}</TableHead>
            <TableHead>{t("table.threshold")}</TableHead>
            <TableHead className="text-right">{t("table.balance")}</TableHead>
            <TableHead>{t("table.pending")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {safes.map((s) => (
            <TableRow key={s.id}>
              <TableCell>
                <Link
                  href={`/safes/${s.id}`}
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
                    linkLabel={t("openInSafeWallet")}
                  />
                ) : (
                  // Not deployed yet: the address column holds a placeholder.
                  <div className="flex flex-wrap items-center gap-2">
                    <SafeStatusBadge status={s.status} />
                    {s.status === "FAILED" && <RetryDeployButton safeId={s.id} />}
                  </div>
                )}
              </TableCell>
              <TableCell className="tabular-nums">{s.ownerCount}</TableCell>
              <TableCell className="tabular-nums">
                {thresholdLabel(s.threshold, s.ownerCount, t)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {s.balance == null
                  ? "—"
                  : `${s.balance}${fund.tokenSymbol ? ` ${fund.tokenSymbol}` : ""}`}
              </TableCell>
              <TableCell>
                {s.pendingCount > 0 ? (
                  <Badge variant="warning">
                    {t("table.pendingCount", { count: s.pendingCount })}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
