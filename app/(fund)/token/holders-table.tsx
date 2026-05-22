// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

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
import { prisma } from "@/services/db/prisma";
import { getBalances, type WalletBalance } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import { cn } from "@/lib/utils";

import { AddressLabel, buildAddressDirectory } from "./address-label";
import { getPlacesForFund } from "./data";

// Alchemy has no "list all holders" endpoint for ERC-20. Instead we look up
// `alchemy_getTokenBalances` for every wallet WE know about — the cards
// issued by this fund, plus the treasury minter addresses. That matches the
// "community currency" framing: this view shows the people in the fund and
// what they hold, not anonymous external wallets (those still appear in the
// transfers tab when they receive payments).
//
// Pagination is local: we already have the full universe so we don't need
// opaque cursors. Sort by balance desc, then slice by `?page=N`.

const PAGE_SIZE = 50;

export async function HoldersTable({
  fund,
  contractAddress,
  chainId,
  decimals,
  symbol,
  minterEoa,
  minterSmartAccount,
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
  page: number;
}) {
  const t = await getTranslations("fund.token.holders");

  const [cards, placesResult, merchants] = await Promise.all([
    prisma.card.findMany({
      where: { account: { not: null }, fundId: fund.id },
      include: {
        member: { select: { firstName: true, lastName: true } },
      },
    }),
    getPlacesForFund(fund.id, fund.citizenPayApiKeyId, fund.citizenPayApiKeyEnc),
    prisma.merchant.findMany({
      where: { fundId: fund.id, citizenPayPlaceId: { not: null } },
      select: { citizenPayPlaceId: true, name: true },
    }),
  ]);

  // Local merchants are the authoritative name when we have one; fall back
  // to whatever CP returns for the place. Keyed by CP's place id.
  const merchantNameByPlaceId = new Map<string, string>();
  for (const m of merchants) {
    if (m.citizenPayPlaceId) merchantNameByPlaceId.set(m.citizenPayPlaceId, m.name);
  }

  const places = placesResult.map((p) => ({
    account: p.account,
    name: merchantNameByPlaceId.get(p.id) ?? p.name,
  }));

  const directory = buildAddressDirectory({
    cards: cards.map((c) => ({
      account: c.account,
      holderName: c.holderName,
      memberName: c.member
        ? `${c.member.firstName} ${c.member.lastName}`.trim()
        : "",
    })),
    places,
    // Holders are bounded by the cards/places/minters universe — there are
    // no "unknown" addresses to enrich via CP profile.
    profiles: [],
    minterEoa,
    minterSmartAccount,
  });

  // Build the universe: every distinct lowercased address we want to
  // surface. Cards, places, minters — dedupe and drop empties.
  const universe = new Set<string>();
  for (const c of cards) {
    if (c.account) universe.add(c.account.toLowerCase());
  }
  for (const p of places) {
    if (p.account) universe.add(p.account.toLowerCase());
  }
  if (minterEoa) universe.add(minterEoa.toLowerCase());
  if (minterSmartAccount) universe.add(minterSmartAccount.toLowerCase());

  const addresses = [...universe];

  let balances: WalletBalance[] = [];
  let errorMessage: string | null = null;
  if (addresses.length > 0) {
    try {
      balances = await getBalances({
        chainId,
        contractAddress,
        addresses,
      });
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      console.error("[token-explorer] balances fetch failed", e);
    }
  }

  if (errorMessage) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {t("error")}
        <p className="mt-1 font-mono text-xs opacity-70">{errorMessage}</p>
      </div>
    );
  }

  // Sort by raw balance descending. Compare as bigints to avoid Number
  // precision loss on large token amounts.
  const sorted = balances.slice().sort((a, b) => {
    const av = hexToBigInt(a.rawBalance);
    const bv = hexToBigInt(b.rawBalance);
    if (av === bv) return a.address.localeCompare(b.address);
    return av < bv ? 1 : -1;
  });

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 1), totalPages);
  const start = (clampedPage - 1) * PAGE_SIZE;
  const slice = sorted.slice(start, start + PAGE_SIZE);

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
            <TableHead className="w-12">#</TableHead>
            <TableHead>{t("holder")}</TableHead>
            <TableHead className="text-right">{t("balance")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {slice.length === 0 ? (
            <TableEmpty colSpan={3}>{t("empty")}</TableEmpty>
          ) : (
            slice.map((h, idx) => (
              <TableRow key={h.address}>
                <TableCell className="text-sm text-muted-foreground tabular-nums">
                  {start + idx + 1}
                </TableCell>
                <TableCell>
                  <AddressLabel
                    address={h.address}
                    directory={directory}
                    side="to"
                    labels={labelDict}
                  />
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatTokenAmount(h.rawBalance, decimals)}
                  {symbol && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {symbol}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {totalPages > 1 && (
        <PageNumberNav
          page={clampedPage}
          totalPages={totalPages}
          labels={{ prev: t("prev"), next: t("next") }}
        />
      )}
    </div>
  );
}

function PageNumberNav({
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
    <div className="flex items-center justify-end gap-2 pt-3 text-sm">
      <Link
        href={{ query: { tab: "holders", page: page - 1 } }}
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
        href={{ query: { tab: "holders", page: page + 1 } }}
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

function hexToBigInt(hex: string): bigint {
  const zero = BigInt(0);
  if (!hex) return zero;
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex : `0x${hex}`;
  try {
    return BigInt(clean);
  } catch {
    return zero;
  }
}
