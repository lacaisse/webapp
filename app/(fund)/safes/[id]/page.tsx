// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { AlertTriangle, ArrowLeft, ExternalLink, Fuel, Info, Loader2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { requireFundRole } from "@/services/auth/dal";
import {
  explorerAddressUrl,
  explorerTxUrl,
  safeWalletTxUrl,
  safeWalletUrl,
} from "@/services/safe/config";

import {
  getCurrentSignerAddress,
  getEligibleMembers,
  getRecipientOptions,
  getRelayerStatus,
  getSafe,
  getSafeBalance,
} from "../data";
import { formatNative, isDeployedAddress, isLowGas, thresholdLabel } from "../format";
import { RetryDeployButton } from "../retry-deploy-button";
import { SafeAddress } from "../safe-address";
import { SafeDetailSkeleton, SafeTxListSkeleton } from "../skeleton";
import { SafeStatusBadge } from "../status-badge";
import { HistoryList } from "./history-list";
import { OwnersCard } from "./owners-card";
import { PendingTxCard } from "./pending-tx-card";
import { SafeManage } from "./safe-manage";
import { SyncButton } from "./sync-button";
import { ProposeTransferDialog } from "./transfer-dialog";

// Synchronous shell so the route paints its skeleton instantly; the Safe
// (params-dependent, uncached) streams in behind <Suspense>.
export default function SafeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<SafeDetailSkeleton />}>
      <SafeDetailView params={params} />
    </Suspense>
  );
}

async function SafeDetailView({ params }: { params: Promise<{ id: string }> }) {
  const { user, fund } = await requireFundRole("ADMIN");
  const { id } = await params;
  const t = await getTranslations("fund.safes");

  const safe = await getSafe(fund.id, id);
  if (!safe) notFound();

  const [signerAddress, members, recipients, relayer] = await Promise.all([
    getCurrentSignerAddress(fund.id, user.id),
    getEligibleMembers(fund.id),
    getRecipientOptions(fund.id),
    getRelayerStatus(safe.chainId),
  ]);

  const token = {
    tokenAddress: fund.tokenAddress,
    tokenChainId: fund.tokenChainId,
    tokenDecimals: fund.tokenDecimals,
  };
  const active = safe.status === "ACTIVE";
  // Before deployment the address column holds a `pending:` placeholder.
  const deployed = isDeployedAddress(safe.address);
  const ownersTotal = safe.owners.length;

  // Address → name for summaries and signer lists: owners (current and
  // former) first, then the fund's accounts / staff cards.
  const names: Record<string, string> = {};
  for (const r of recipients) names[r.address.toLowerCase()] = r.label;
  for (const o of [...safe.formerOwners, ...safe.owners]) {
    names[o.address.toLowerCase()] = o.displayName;
  }

  // Nonces that already have a competing rejection in flight.
  const rejectedNonces = new Set(
    safe.pending.filter((tx) => tx.kind === "REJECTION").map((tx) => tx.nonce),
  );

  // The Safe executes strictly in nonce order: the lowest open nonce is next
  // in line, everything above it waits for it.
  const nextNonce = safe.pending.length > 0 ? safe.pending[0]!.nonce : null;

  const ownerRows = safe.owners.map((o) => ({
    address: o.address,
    kind: o.kind,
    label: o.label,
    displayName: o.displayName,
    userId: o.userId,
    email: o.email,
    image: o.image,
    isFormerMember: o.isFormerMember,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/safes"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("detail.back")}
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-medium">{safe.name}</h1>
            <SafeStatusBadge status={safe.status} />
            <Badge variant="outline">
              {t("detail.thresholdChip", {
                threshold: thresholdLabel(safe.threshold, ownersTotal, t),
              })}
            </Badge>
          </div>
          {deployed && (
            <div className="flex flex-wrap items-center gap-3">
              <SafeAddress address={safe.address} full />
              {safe.status !== "DEPLOYING" && (
                <a
                  href={safeWalletUrl(safe.chainId, safe.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {t("openInSafeWallet")}
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          )}
        </div>
        <SafeManage
          safeId={safe.id}
          name={safe.name}
          openCount={safe.pending.length}
        />
      </header>

      {safe.status === "DEPLOYING" && (
        <Alert>
          <Loader2 className="size-4 animate-spin" />
          <AlertDescription>
            {t("detail.deploying")}
            {safe.deployTxHash && (
              <a
                href={explorerTxUrl(safe.chainId, safe.deployTxHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 font-mono text-xs"
              >
                {safe.deployTxHash.slice(0, 10)}…
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
      {safe.status === "FAILED" && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{t("detail.deployFailed")}</AlertTitle>
          <AlertDescription className="space-y-2">
            {safe.errorMessage && <p className="break-words">{safe.errorMessage}</p>}
            <RetryDeployButton safeId={safe.id} />
          </AlertDescription>
        </Alert>
      )}
      {!relayer.configured && (
        <Alert variant="warning">
          <Info className="size-4" />
          <AlertDescription>{t("relayerMissing")}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">{t("detail.balance")}</div>
          <div className="mt-1 text-lg font-medium tabular-nums">
            <Suspense fallback={<Skeleton className="h-6 w-24" />}>
              <SafeBalance
                chainId={safe.chainId}
                address={safe.address}
                token={token}
                symbol={fund.tokenSymbol}
              />
            </Suspense>
          </div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">{t("detail.threshold")}</div>
          <div className="mt-1 text-lg font-medium tabular-nums">
            {thresholdLabel(safe.threshold, ownersTotal, t)}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("detail.thresholdHint", { threshold: safe.threshold })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {active && fund.tokenAddress && (
            <ProposeTransferDialog
              safeId={safe.id}
              chainId={safe.chainId}
              threshold={safe.threshold}
              options={recipients.filter(
                (r) => r.address.toLowerCase() !== safe.address.toLowerCase(),
              )}
              symbol={fund.tokenSymbol}
            />
          )}
        </div>
      </div>

      <OwnersCard
        safeId={safe.id}
        chainId={safe.chainId}
        threshold={safe.threshold}
        owners={ownerRows}
        members={members.map((m) => ({
          userId: m.userId,
          name: m.name,
          email: m.email,
          signerAddress: m.signerAddress,
        }))}
        currentUserId={user.id}
        canPropose={active}
      />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-lg font-medium">
            {t("detail.pendingTitle")}
            {safe.pending.length > 0 && (
              <span className="ml-2 text-sm text-muted-foreground tabular-nums">
                {safe.pending.length}
              </span>
            )}
          </h2>
          {deployed && safe.status !== "DEPLOYING" && <SyncButton safeId={safe.id} />}
        </div>
        {safe.pending.length === 0 ? (
          <div className="rounded-lg border border-border py-8 text-center text-sm text-muted-foreground">
            {t("detail.pendingEmpty")}
          </div>
        ) : (
          <div className="space-y-3">
            {safe.pending.map((tx) => (
              <PendingTxCard
                nextNonce={nextNonce}
                key={tx.id}
                safeId={safe.id}
                tx={tx}
                owners={ownerRows}
                threshold={safe.threshold}
                currentSignerAddress={signerAddress}
                tokenSymbol={fund.tokenSymbol}
                names={names}
                safeWalletTxHref={
                  deployed ? safeWalletTxUrl(safe.chainId, safe.address, tx.safeTxHash) : null
                }
                canAct={active}
                rejectionProposed={tx.kind !== "REJECTION" && rejectedNonces.has(tx.nonce)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">{t("history.title")}</h2>
        <Suspense fallback={<SafeTxListSkeleton />}>
          <HistoryList
            chainId={safe.chainId}
            history={safe.history}
            tokenSymbol={fund.tokenSymbol}
            names={names}
          />
        </Suspense>
      </section>

      {relayer.configured && isLowGas(relayer.balanceWei) && (
        <Alert variant="warning">
          <Fuel className="size-4" />
          <AlertTitle>{t("relayer.lowGas")}</AlertTitle>
          <AlertDescription>
            {t("relayer.lowGasBody", {
              balance: formatNative(relayer.balanceWei!),
            })}
            {relayer.address && (
              <a
                href={explorerAddressUrl(safe.chainId, relayer.address)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 font-mono text-xs"
              >
                {relayer.address}
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// The token balance is an Alchemy round-trip — stream it on its own so the
// signatures (the important part) paint first.
async function SafeBalance({
  chainId,
  address,
  token,
  symbol,
}: {
  chainId: number;
  address: string;
  token: {
    tokenAddress: string | null;
    tokenChainId: number | null;
    tokenDecimals: number | null;
  };
  symbol: string | null;
}) {
  const t = await getTranslations("fund.safes");
  const { balance, error } = await getSafeBalance(chainId, address, token);
  if (balance == null) {
    return (
      <span title={error ? t("balancesError") : undefined} className="text-muted-foreground">
        —
      </span>
    );
  }
  return <>{`${balance}${symbol ? ` ${symbol}` : ""}`}</>;
}
