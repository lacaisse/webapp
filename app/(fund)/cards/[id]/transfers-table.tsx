// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { ArrowRight, ChevronRight, RotateCcw } from "lucide-react";
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
import { TxAnnotationCell } from "@/components/tx-annotation";
import { cn } from "@/lib/utils";
import { formatTokenAmount, isZeroAddress } from "@/services/alchemy/format";
import { listTransfersForAccount } from "@/services/alchemy/transfers";
import { prisma } from "@/services/db/prisma";
import { getAnnotations } from "@/services/transaction-annotation/annotate";

import {
  AddressLabel,
  buildAddressDirectory,
} from "../../token/address-label";
import { getPlacesForFund, getProfile } from "../../token/data";

const PAGE_SIZE = 25;

// Per-card view of the same on-chain transfer log shown by /token. We
// reuse the address directory + AddressLabel so labels (cards / places /
// CP profiles / treasury / mint+burn) stay consistent across the app.
// Pagination piggy-backs on the dual-stream cursor produced by
// listTransfersForAccount — see services/alchemy/transfers.ts.

export async function CardTransfersTable({
  fund,
  contractAddress,
  chainId,
  decimals,
  symbol,
  minterEoa,
  minterSmartAccount,
  account,
  cursor,
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
  cursor: string | null;
}) {
  const t = await getTranslations("fund.cards.detail.transfers");
  const tAcc = await getTranslations("fund.accounts");
  const format = await getFormatter();

  const [page, cards, placesResult, merchants, tokenAccounts] =
    await Promise.all([
      safeListTransfers({
        chainId,
        contractAddress,
        account,
        pageSize: PAGE_SIZE,
        cursor,
      }),
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

  if (page.error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {t("error")}
        <p className="mt-1 font-mono text-xs opacity-70">{page.error}</p>
      </div>
    );
  }

  const annotations = await getAnnotations(
    fund.id,
    page.transfers.map((tx) => tx.hash),
  );

  const merchantNameByPlaceId = new Map<string, string>();
  for (const m of merchants) {
    if (m.citizenPayPlaceId)
      merchantNameByPlaceId.set(m.citizenPayPlaceId, m.name);
  }

  const knownLocal = new Set<string>();
  for (const c of cards) if (c.account) knownLocal.add(c.account.toLowerCase());
  for (const p of placesResult)
    if (p.account) knownLocal.add(p.account.toLowerCase());
  if (minterEoa) knownLocal.add(minterEoa.toLowerCase());
  if (minterSmartAccount) knownLocal.add(minterSmartAccount.toLowerCase());

  const unresolved = new Set<string>();
  for (const tx of page.transfers) {
    for (const addr of [tx.from, tx.to]) {
      const lower = addr.toLowerCase();
      if (isZeroAddress(lower) || knownLocal.has(lower)) continue;
      unresolved.add(lower);
    }
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

  // Override the entry for the card we're viewing so its row labels read
  // "This card" rather than echoing its own holder name on every line —
  // it's the implicit subject of the page.
  directory.cards.set(account.toLowerCase(), { name: t("self") });

  const labelDict = {
    issued: t("issued"),
    retired: t("retired"),
    treasury: t("treasury"),
    unknown: t("unknown"),
  };

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("date")}</TableHead>
            <TableHead>{t("from")}</TableHead>
            <TableHead aria-label="" className="w-6" />
            <TableHead>{t("to")}</TableHead>
            <TableHead className="text-right">{t("amount")}</TableHead>
            <TableHead>{t("note")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.transfers.length === 0 ? (
            <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
          ) : (
            page.transfers.map((tx) => (
              <TableRow key={tx.uniqueId}>
                <TableCell className="text-sm text-muted-foreground">
                  {tx.blockTimestamp
                    ? format.dateTime(new Date(tx.blockTimestamp), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "—"}
                </TableCell>
                <TableCell>
                  <AddressLabel
                    address={tx.from}
                    directory={directory}
                    side="from"
                    labels={labelDict}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <ArrowRight className="size-3.5" />
                </TableCell>
                <TableCell>
                  <AddressLabel
                    address={tx.to}
                    directory={directory}
                    side="to"
                    labels={labelDict}
                  />
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatTokenAmount(tx.rawValue, decimals)}
                  {symbol && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {symbol}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <TxAnnotationCell
                    txHash={tx.hash}
                    kind={annotations.get(tx.hash.toLowerCase())?.kind ?? null}
                    note={annotations.get(tx.hash.toLowerCase())?.note ?? null}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <Pager
        cursor={cursor}
        nextPageKey={page.nextPageKey}
        labels={{ newer: t("newer"), older: t("older") }}
      />
    </div>
  );
}

// Cursor-only pager (no tab to preserve here — the card detail page has
// no other tabbed surface in the URL).
function Pager({
  cursor,
  nextPageKey,
  labels,
}: {
  cursor: string | null;
  nextPageKey: string | null;
  labels: { newer: string; older: string };
}) {
  if (!cursor && !nextPageKey) return null;
  return (
    <div className="flex items-center justify-end gap-2 pt-3">
      <Link
        href={{ query: {} }}
        scroll={false}
        aria-disabled={!cursor}
        tabIndex={cursor ? undefined : -1}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          !cursor && "pointer-events-none opacity-50",
        )}
      >
        <RotateCcw className="size-3.5" />
        {labels.newer}
      </Link>
      <Link
        href={{ query: { cursor: nextPageKey ?? undefined } }}
        scroll={false}
        aria-disabled={!nextPageKey}
        tabIndex={nextPageKey ? undefined : -1}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          !nextPageKey && "pointer-events-none opacity-50",
        )}
      >
        {labels.older}
        <ChevronRight className="size-3.5" />
      </Link>
    </div>
  );
}

async function safeListTransfers(
  opts: Parameters<typeof listTransfersForAccount>[0],
) {
  try {
    const result = await listTransfersForAccount(opts);
    return { ...result, error: null as string | null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cards.detail] transfers fetch failed", e);
    return { transfers: [], nextPageKey: null, error: msg };
  }
}
