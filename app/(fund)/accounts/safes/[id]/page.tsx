// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Fuel,
  Info,
  Loader2,
  Send,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import { requireFundRole } from "@/services/auth/dal";
import { syncSafe } from "@/services/safe/sync";
import {
  explorerAddressUrl,
  explorerTxUrl,
  safeWalletTxUrl,
  safeWalletUrl,
} from "@/services/safe/config";
import type { SafeTransfersFund } from "@/services/safe/transfers";
import { getDisplayTokens, type DisplayTokensFund } from "@/services/token/display-tokens";
import type { ExtraToken } from "@/services/token/extra-tokens";

import { getAccountOptions } from "../../data";
import { ExtraBalanceLines, extraLinesFor } from "../../extra-balance-lines";
import { getExtraBalances, type ExtraBalances } from "../../extra-balances";
import { TransfersTableSkeleton } from "../../skeleton";
import {
  getCurrentSignerAddress,
  getEligibleMembers,
  getRecipientOptions,
  getRelayerStatus,
  getSafe,
  getSafeBalance,
  getSafeTransfersFirstPage,
  userHasPasskey,
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
import { SafeTransfersTable } from "./safe-transfers-table";
import { SyncButton } from "./sync-button";
import { ProposeTransferDialog, type TransferTokenOption } from "./transfer-dialog";

// Server actions invoked from this route broadcast a Safe transaction and wait
// for its receipt (relayer.ts, up to 90 s); give them room on Vercel.
export const maxDuration = 120;

// A Safe is an account first: the page leads with its on-chain history
// (`?tab=transactions`, the default); owners, threshold and past proposals sit
// under `?tab=signers`. Open proposals stay above the tabs — they need action.
const TABS = [{ value: "transactions" }, { value: "signers" }] as const;

type SearchParams = Promise<{ tab?: string | string[] }>;

// Synchronous shell so the route paints its skeleton instantly; the Safe
// (params-dependent, uncached) streams in behind <Suspense>.
export default function SafeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  return (
    <Suspense fallback={<SafeDetailSkeleton />}>
      <SafeDetailView params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function SafeDetailView({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { user, fund } = await requireFundRole("ADMIN");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const activeTab = resolveActiveTab(sp.tab, TABS);
  const [t, tAccounts] = await Promise.all([
    getTranslations("fund.safes"),
    getTranslations("fund.accounts"),
  ]);

  // Pull owners / threshold / Safe{Wallet} confirmations before rendering
  // (30 s debounce inside syncSafe; never fails the page).
  try {
    await syncSafe({ fundId: fund.id, safeId: id });
  } catch (e) {
    console.warn("[safes] page sync failed", id, e);
  }

  const safe = await getSafe(fund.id, id);
  if (!safe) notFound();

  const [signerAddress, members, recipients, relayer, fundAccounts, hasPasskey] =
    await Promise.all([
      getCurrentSignerAddress(fund.id, user.id),
      getEligibleMembers(fund.id),
      getRecipientOptions(fund.id),
      getRelayerStatus(safe.chainId),
      getAccountOptions(fund.id, ""),
      userHasPasskey(user.id),
    ]);

  const token = {
    tokenAddress: fund.tokenAddress,
    tokenChainId: fund.tokenChainId,
    tokenDecimals: fund.tokenDecimals,
  };
  const display: DisplayTokensFund = {
    id: fund.id,
    tokenChainId: fund.tokenChainId,
    showNativeBalance: fund.showNativeBalance,
    showEureBalance: fund.showEureBalance,
  };
  // xDAI / EURe / custom tokens the fund opted into; only for a Safe on the
  // fund's chain.
  const sameChain = safe.chainId === fund.tokenChainId;
  const extraTokens = sameChain ? await getDisplayTokens(display) : [];
  // One Alchemy round-trip for the balance card and the transfer dialog's
  // token picker; both await it inside their own <Suspense>.
  const balances: Promise<SafeBalances> = Promise.all([
    getSafeBalance(safe.chainId, safe.address, token),
    getExtraBalances(display, sameChain ? [safe.address] : []),
  ]).then(([main, extra]) => ({ main, extra }));
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

  // Counterparty names for the on-chain history: the fund's accounts, the
  // Safe's owners (current and former), and the Safe itself.
  const transferNames: Record<string, string> = {};
  for (const a of fundAccounts) {
    transferNames[a.address.toLowerCase()] = a.name || tAccounts("defaultName");
  }
  for (const o of [...safe.formerOwners, ...safe.owners]) {
    transferNames[o.address.toLowerCase()] = o.displayName;
  }
  if (deployed) transferNames[safe.address.toLowerCase()] = safe.name;

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
          href="/accounts"
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
      {safe.status === "ACTIVE" && safe.errorMessage && (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>{t("detail.syncProblem")}</AlertTitle>
          <AlertDescription className="break-words font-mono text-xs">
            {safe.errorMessage}
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
                address={safe.address}
                balances={balances}
                symbol={fund.tokenSymbol}
                extraTokens={extraTokens}
                sameChain={sameChain}
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
            <Suspense
              fallback={
                <Button size="sm" disabled>
                  <Send className="size-4" />
                  {t("transfer.trigger")}
                </Button>
              }
            >
              <ProposeTransferSlot
                safeId={safe.id}
                chainId={safe.chainId}
                threshold={safe.threshold}
                options={recipients.filter(
                  (r) => r.address.toLowerCase() !== safe.address.toLowerCase(),
                )}
                address={safe.address}
                balances={balances}
                fundSymbol={fund.tokenSymbol}
                extraTokens={extraTokens}
                hasPasskey={hasPasskey}
              />
            </Suspense>
          )}
        </div>
      </div>

      {safe.pending.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-lg font-medium">
              {t("detail.pendingTitle")}
              <span className="ml-2 text-sm text-muted-foreground tabular-nums">
                {safe.pending.length}
              </span>
            </h2>
            {deployed && safe.status !== "DEPLOYING" && <SyncButton safeId={safe.id} />}
          </div>
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
                hasPasskey={hasPasskey}
              />
            ))}
          </div>
        </section>
      )}

      <Tabs
        active={activeTab}
        items={TABS.map((tab) => ({
          value: tab.value,
          label: t(`tabs.${tab.value}`),
        }))}
      />

      {activeTab === "transactions" && (
        <section className="space-y-3">
          <Suspense fallback={<TransfersTableSkeleton />}>
            <SafeTransfersSection
              fundId={fund.id}
              fund={{
                tokenChainId: fund.tokenChainId,
                tokenAddress: fund.tokenAddress,
                tokenDecimals: fund.tokenDecimals,
                tokenSymbol: fund.tokenSymbol,
                showNativeBalance: fund.showNativeBalance,
                showEureBalance: fund.showEureBalance,
              }}
              safeId={safe.id}
              chainId={safe.chainId}
              address={safe.address}
              accountNames={transferNames}
            />
          </Suspense>
        </section>
      )}

      {activeTab === "signers" && (
        <>
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
            hasPasskey={hasPasskey}
          />

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-heading text-lg font-medium">{t("history.title")}</h2>
              {/* With proposals open the sync sits on that section, above. */}
              {safe.pending.length === 0 && deployed && safe.status !== "DEPLOYING" && (
                <SyncButton safeId={safe.id} />
              )}
            </div>
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
        </>
      )}
    </div>
  );
}

// The on-chain history is an Alchemy round-trip (several assets) — stream it
// in its own boundary so the header, balance and open proposals paint first.
async function SafeTransfersSection({
  fundId,
  fund,
  safeId,
  chainId,
  address,
  accountNames,
}: {
  fundId: string;
  fund: SafeTransfersFund;
  safeId: string;
  chainId: number;
  address: string;
  accountNames: Record<string, string>;
}) {
  const t = await getTranslations("fund.accounts");
  const first = await getSafeTransfersFirstPage(fundId, fund, chainId, address);
  return (
    <>
      {first.error && (
        <Alert variant="warning">
          <AlertDescription>{t("transfers.loadError")}</AlertDescription>
        </Alert>
      )}
      <SafeTransfersTable
        safeId={safeId}
        initial={first.transfers}
        initialCursor={first.nextCursor}
        symbol={fund.tokenSymbol}
        accountNames={accountNames}
      />
    </>
  );
}

type SafeBalances = {
  main: { balance: string | null; error: boolean };
  extra: ExtraBalances;
};

// The token balance is an Alchemy round-trip — stream it on its own so the
// signatures (the important part) paint first.
async function SafeBalance({
  address,
  balances,
  symbol,
  extraTokens,
  sameChain,
}: {
  address: string;
  balances: Promise<SafeBalances>;
  symbol: string | null;
  extraTokens: ExtraToken[];
  sameChain: boolean;
}) {
  const t = await getTranslations("fund.safes");
  const {
    main: { balance, error },
    extra,
  } = await balances;
  const lines = extraLinesFor(address, extraTokens, extra, sameChain);
  return (
    <>
      {balance == null ? (
        <span title={error ? t("balancesError") : undefined} className="text-muted-foreground">
          —
        </span>
      ) : (
        `${balance}${symbol ? ` ${symbol}` : ""}`
      )}
      <ExtraBalanceLines lines={lines} className="mt-1 font-normal" />
    </>
  );
}

// "Propose transfer" waits for the balances so its token picker can show
// what each one holds ("EURe · 0.75"): the fund token first, then each extra
// token the fund enabled.
async function ProposeTransferSlot({
  address,
  balances,
  fundSymbol,
  extraTokens,
  ...dialog
}: {
  safeId: string;
  chainId: number;
  threshold: number;
  options: { address: string; label: string; kind: "ACCOUNT" | "CARD" }[];
  hasPasskey: boolean;
  address: string;
  balances: Promise<SafeBalances>;
  fundSymbol: string | null;
  extraTokens: ExtraToken[];
}) {
  const { main, extra } = await balances;
  const held = extra.byAddress.get(address.toLowerCase());
  const tokens: TransferTokenOption[] = [
    { key: "fund", symbol: fundSymbol, balance: main.balance },
    ...extraTokens.map((tok) => ({
      key: tok.key,
      symbol: tok.symbol,
      balance: held?.find((b) => b.key === tok.key)?.amount ?? null,
    })),
  ];
  return <ProposeTransferDialog {...dialog} tokens={tokens} />;
}
