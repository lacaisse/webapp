// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowRight } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

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
import { prisma } from "@/services/db/prisma";
import { formatTokenAmount, isZeroAddress } from "@/services/alchemy/format";
import { listTransfers } from "@/services/alchemy/transfers";
import { getAnnotations } from "@/services/transaction-annotation/annotate";

import { AddressLabel, buildAddressDirectory } from "./address-label";
import { getPlacesForFund, getProfile } from "./data";
import { Pagination } from "./pagination";

const PAGE_SIZE = 50;

export async function TransfersTable({
  fund,
  contractAddress,
  chainId,
  decimals,
  symbol,
  minterEoa,
  minterSmartAccount,
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
  cursor: string | null;
}) {
  const t = await getTranslations("fund.token.transfers");
  const tAcc = await getTranslations("fund.accounts");
  const format = await getFormatter();

  // Fetch in parallel: on-chain transfers, local card directory (members),
  // CitizenPay places (merchants), local merchants (so we can prefer a polished
  // local name over CP's raw place name), and the fund's named token accounts.
  const [page, cards, placesResult, merchants, tokenAccounts] =
    await Promise.all([
      safeListTransfers({
        chainId,
        contractAddress,
        pageSize: PAGE_SIZE,
        pageKey: cursor,
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

  // Fund's per-tx annotations for the hashes on this page.
  const annotations = await getAnnotations(
    fund.id,
    page.transfers.map((tx) => tx.hash),
  );

  const merchantNameByPlaceId = new Map<string, string>();
  for (const m of merchants) {
    if (m.citizenPayPlaceId) merchantNameByPlaceId.set(m.citizenPayPlaceId, m.name);
  }

  // Any address we *can* label locally — skip the CP profile fetch for
  // these. Lowercased so the comparison matches Alchemy's casing.
  const knownLocal = new Set<string>();
  for (const c of cards) if (c.account) knownLocal.add(c.account.toLowerCase());
  for (const p of placesResult) if (p.account) knownLocal.add(p.account.toLowerCase());
  if (minterEoa) knownLocal.add(minterEoa.toLowerCase());
  if (minterSmartAccount) knownLocal.add(minterSmartAccount.toLowerCase());

  // External wallets that appear on this page and aren't labelled locally.
  // Fetch a CP profile for each so we can show a name instead of "Unknown".
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
            <TableHead>{t("trigger")}</TableHead>
            <TableHead>{t("note")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.transfers.length === 0 ? (
            <TableEmpty colSpan={7}>{t("empty")}</TableEmpty>
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
                  <TxTriggerCell
                    trigger={
                      annotations.get(tx.hash.toLowerCase())?.trigger ?? null
                    }
                    triggeredBy={
                      annotations.get(tx.hash.toLowerCase())?.triggeredByName ??
                      null
                    }
                  />
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
      <Pagination
        tab="transfers"
        cursor={cursor}
        nextPageKey={page.nextPageKey}
        labels={{ newer: t("newer"), older: t("older") }}
      />
    </div>
  );
}

async function safeListTransfers(opts: Parameters<typeof listTransfers>[0]) {
  try {
    const result = await listTransfers(opts);
    return { ...result, error: null as string | null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[token-explorer] transfers fetch failed", e);
    return { transfers: [], nextPageKey: null, error: msg };
  }
}

