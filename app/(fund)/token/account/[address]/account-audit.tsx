// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  History,
  Repeat,
} from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TxAnnotationCell, TxTriggerCell } from "@/components/tx-annotation";
import { cn } from "@/lib/utils";
import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount, isZeroAddress } from "@/services/alchemy/format";
import { getTotalSupply } from "@/services/alchemy/supply";
import { prisma } from "@/services/db/prisma";
import { loadFullAccountHistory } from "@/services/token-audit/history";
import {
  buildBalanceTimeline,
  formatSignedAmount,
  hexToBigInt,
  type TimelineDirection,
} from "@/services/token-audit/timeline";
import { getAnnotations } from "@/services/transaction-annotation/annotate";

import { AddressLabel, AddressLink, buildAddressDirectory } from "../../address-label";
import { getPlacesForFund, getProfile } from "../../data";

const PAGE_SIZE = 50;

// The audit body: summary tiles (balance, in, out, reconciliation verdict) and
// the full history with a running "balance after" per row. History is fetched
// in full (services/token-audit/history) because a running balance is only
// meaningful over a gap-free window; pagination is a local slice via ?page=N.

export async function AccountAudit({
  fund,
  contractAddress,
  chainId,
  decimals,
  symbol,
  minterEoa,
  minterSmartAccount,
  account,
  page,
}: {
  fund: {
    id: string;
    citizenPayApiKeyId: string | null;
    citizenPayApiKeyEnc: string | null;
  };
  contractAddress: string;
  chainId: number;
  decimals: number;
  symbol: string | null;
  minterEoa: string | null;
  minterSmartAccount: string | null;
  account: string;
  page: number;
}) {
  const t = await getTranslations("fund.token.account");
  const tAcc = await getTranslations("fund.accounts");
  const format = await getFormatter();

  // On-chain reads soft-fail into an error panel; Prisma/CP directory reads
  // follow the explorer's existing degradation behaviour.
  const [historyRes, balanceRes, supplyHex, cards, placesResult, merchants, tokenAccounts] =
    await Promise.all([
      attempt(
        loadFullAccountHistory({ chainId, contractAddress, account }),
      ),
      attempt(
        getBalances({ chainId, contractAddress, addresses: [account] }),
      ),
      getTotalSupply(chainId, contractAddress).catch(() => null),
      prisma.card.findMany({
        where: { account: { not: null }, fundId: fund.id },
        include: {
          member: { select: { firstName: true, lastName: true } },
        },
      }),
      getPlacesForFund(
        fund.id,
        fund.citizenPayApiKeyId,
        fund.citizenPayApiKeyEnc,
      ),
      prisma.merchant.findMany({
        where: { fundId: fund.id, citizenPayPlaceId: { not: null } },
        select: { citizenPayPlaceId: true, name: true },
      }),
      prisma.fundTokenAccount.findMany({
        where: { fundId: fund.id, archivedAt: null },
        select: { name: true, address: true },
      }),
    ]);

  if (historyRes.error != null || balanceRes.error != null) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {t("error")}
        <p className="mt-1 font-mono text-xs opacity-70">
          {historyRes.error ?? balanceRes.error}
        </p>
      </div>
    );
  }

  const currentBalance = hexToBigInt(balanceRes.data[0]?.rawBalance);
  const timeline = buildBalanceTimeline({
    account,
    currentBalance,
    transfers: historyRes.data.transfers,
  });

  const total = timeline.entries.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 1), totalPages);
  const start = (clampedPage - 1) * PAGE_SIZE;
  const slice = timeline.entries.slice(start, start + PAGE_SIZE);

  const annotations = await getAnnotations(
    fund.id,
    slice.map((e) => e.transfer.hash),
  );

  const merchantNameByPlaceId = new Map<string, string>();
  for (const m of merchants) {
    if (m.citizenPayPlaceId) merchantNameByPlaceId.set(m.citizenPayPlaceId, m.name);
  }

  // CP-profile enrichment for addresses on this page we can't label locally —
  // same pattern as the transfers tab. Includes the audited account itself so
  // the identity line can show a name for an external wallet.
  const knownLocal = new Set<string>();
  for (const c of cards) if (c.account) knownLocal.add(c.account.toLowerCase());
  for (const p of placesResult) if (p.account) knownLocal.add(p.account.toLowerCase());
  for (const a of tokenAccounts) knownLocal.add(a.address.toLowerCase());
  if (minterEoa) knownLocal.add(minterEoa.toLowerCase());
  if (minterSmartAccount) knownLocal.add(minterSmartAccount.toLowerCase());

  const unresolved = new Set<string>();
  for (const addr of [account, ...slice.map((e) => e.counterparty)]) {
    const lower = addr.toLowerCase();
    if (isZeroAddress(lower) || knownLocal.has(lower)) continue;
    unresolved.add(lower);
  }

  const fetchedProfiles =
    unresolved.size === 0
      ? []
      : await Promise.all(
          [...unresolved].map(async (addr) => {
            const p = await getProfile(
              fund.id,
              fund.citizenPayApiKeyId,
              fund.citizenPayApiKeyEnc,
              addr,
            );
            if (!p) return null;
            const name = p.name?.trim() || p.username?.trim();
            if (!name) return null;
            return { account: addr, name, imageSmall: p.imageSmall };
          }),
        ).then((arr) =>
          arr.filter((x): x is NonNullable<typeof x> => x != null),
        );

  const directory = buildAddressDirectory({
    cards: cards.map((c) => ({
      account: c.account,
      holderName: c.holderName,
      memberName: c.member
        ? `${c.member.firstName} ${c.member.lastName}`.trim()
        : "",
      serialNumber: c.serialNumber,
    })),
    places: placesResult.map((p) => ({
      account: p.account,
      name: merchantNameByPlaceId.get(p.id) ?? p.name,
    })),
    accounts: tokenAccounts.map((a) => ({
      account: a.address,
      name: a.name || tAcc("defaultName"),
    })),
    profiles: fetchedProfiles,
    minterEoa,
    minterSmartAccount,
  });

  const labelDict = {
    issued: t("issued"),
    retired: t("retired"),
    treasury: t("treasury"),
    unknown: t("unknown"),
  };

  const fmt = (raw: string) => formatTokenAmount(raw, decimals);
  const fmtBalance = (v: bigint) =>
    v < BigInt(0) ? `−${fmt((-v).toString())}` : fmt(v.toString());

  const supply = supplyHex != null ? hexToBigInt(supplyHex) : null;
  const sharePct =
    supply != null && supply > BigInt(0)
      ? Number((currentBalance * BigInt(10_000)) / supply) / 100
      : null;

  const inCount = timeline.entries.filter((e) => e.direction === "in").length;
  const outCount = timeline.entries.filter((e) => e.direction === "out").length;

  const verdict = !historyRes.data.complete
    ? "truncated"
    : timeline.openingBalance === BigInt(0)
      ? "reconciled"
      : "unexplained";

  return (
    <div className="space-y-4">
      <div className="text-base">
        <AddressLabel
          address={account}
          directory={directory}
          side="to"
          labels={labelDict}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          label={t("balance")}
          value={withSymbol(fmtBalance(currentBalance), symbol)}
          hint={
            sharePct != null ? t("shareOfSupply", { share: sharePct }) : null
          }
        />
        <SummaryTile
          label={t("totalIn")}
          value={withSymbol(`+${fmt(timeline.totalIn.toString())}`, symbol)}
          hint={t("transfersIn", { count: inCount })}
        />
        <SummaryTile
          label={t("totalOut")}
          value={withSymbol(`−${fmt(timeline.totalOut.toString())}`, symbol)}
          hint={t("transfersOut", { count: outCount })}
        />
        {verdict === "reconciled" && (
          <SummaryTile
            label={t("status")}
            value={
              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <CircleCheck className="size-4" />
                {t("reconciled")}
              </span>
            }
            hint={t("reconciledHint")}
          />
        )}
        {verdict === "unexplained" && (
          <SummaryTile
            label={t("status")}
            value={
              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <CircleAlert className="size-4" />
                {t("unexplained")}
              </span>
            }
            hint={t("unexplainedHint", {
              amount: withSymbol(
                formatSignedAmount(timeline.openingBalance, fmt),
                symbol,
              ),
            })}
          />
        )}
        {verdict === "truncated" && (
          <SummaryTile
            label={t("status")}
            value={
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <History className="size-4" />
                {t("truncated")}
              </span>
            }
            hint={t("truncatedHint", {
              count: total,
              amount: withSymbol(fmtBalance(timeline.openingBalance), symbol),
            })}
          />
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("date")}</TableHead>
            <TableHead>{t("counterparty")}</TableHead>
            <TableHead className="text-right">{t("amount")}</TableHead>
            <TableHead className="text-right">{t("balanceAfter")}</TableHead>
            <TableHead>{t("trigger")}</TableHead>
            <TableHead>{t("note")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {slice.length === 0 ? (
            <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
          ) : (
            slice.map((entry) => (
              <TableRow key={entry.transfer.uniqueId}>
                <TableCell className="text-sm text-muted-foreground">
                  {entry.transfer.blockTimestamp
                    ? format.dateTime(new Date(entry.transfer.blockTimestamp), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "—"}
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <DirectionIcon direction={entry.direction} />
                    <AddressLink address={entry.counterparty}>
                      <AddressLabel
                        address={entry.counterparty}
                        directory={directory}
                        side={entry.direction === "in" ? "from" : "to"}
                        labels={labelDict}
                      />
                    </AddressLink>
                  </span>
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-medium tabular-nums",
                    entry.direction === "in" &&
                      "text-emerald-600 dark:text-emerald-400",
                    entry.direction === "self" && "text-muted-foreground",
                  )}
                >
                  {formatSignedAmount(entry.delta, fmt)}
                  {symbol && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {symbol}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                  {fmtBalance(entry.balanceAfter)}
                </TableCell>
                <TableCell>
                  <TxTriggerCell
                    trigger={
                      annotations.get(entry.transfer.hash.toLowerCase())
                        ?.trigger ?? null
                    }
                    triggeredBy={
                      annotations.get(entry.transfer.hash.toLowerCase())
                        ?.triggeredByName ?? null
                    }
                  />
                </TableCell>
                <TableCell>
                  <TxAnnotationCell
                    txHash={entry.transfer.hash}
                    kind={
                      annotations.get(entry.transfer.hash.toLowerCase())?.kind ??
                      null
                    }
                    note={
                      annotations.get(entry.transfer.hash.toLowerCase())?.note ??
                      null
                    }
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {totalPages > 1 && (
        <PageNav
          page={clampedPage}
          totalPages={totalPages}
          labels={{ prev: t("prev"), next: t("next") }}
        />
      )}
    </div>
  );
}

function withSymbol(amount: string, symbol: string | null): string {
  return symbol ? `${amount} ${symbol}` : amount;
}

function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode | null;
}) {
  return (
    <div className="space-y-1 rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-medium tabular-nums">{value}</p>
      {hint != null && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function DirectionIcon({ direction }: { direction: TimelineDirection }) {
  if (direction === "in")
    return <ArrowDownLeft className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  if (direction === "out")
    return <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />;
  return <Repeat className="size-3.5 shrink-0 text-muted-foreground" />;
}

function PageNav({
  page,
  totalPages,
  labels,
}: {
  page: number;
  totalPages: number;
  labels: { prev: string; next: string };
}) {
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  return (
    <div className="flex items-center justify-end gap-2 pt-1 text-sm">
      <Link
        href={{ query: { page: page - 1 } }}
        scroll={false}
        aria-disabled={!hasPrev}
        tabIndex={hasPrev ? undefined : -1}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          !hasPrev && "pointer-events-none opacity-50",
        )}
      >
        <ChevronLeft className="size-3.5" />
        {labels.prev}
      </Link>
      <span className="px-1 text-xs text-muted-foreground tabular-nums">
        {page} / {totalPages}
      </span>
      <Link
        href={{ query: { page: page + 1 } }}
        scroll={false}
        aria-disabled={!hasNext}
        tabIndex={hasNext ? undefined : -1}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          !hasNext && "pointer-events-none opacity-50",
        )}
      >
        {labels.next}
        <ChevronRight className="size-3.5" />
      </Link>
    </div>
  );
}

async function attempt<T>(
  p: Promise<T>,
): Promise<{ data: T; error: null } | { data: never; error: string }> {
  try {
    return { data: await p, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[token-audit] on-chain fetch failed", e);
    return { data: undefined as never, error: msg };
  }
}
