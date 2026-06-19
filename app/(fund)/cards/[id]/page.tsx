// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Coins, Download } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CopyButton } from "@/components/copy-button";
import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount, shortAddress } from "@/services/alchemy/format";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import {
  type CardStatus as CardStatusEnum,
} from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";

import { CardRowActions } from "../card-row-actions";
import { TableSkeleton } from "../../token/skeleton";
import { CardNumberEdit } from "./card-number-edit";
import { CardSourcePicker } from "./source-picker";
import { CardTransfersTable } from "./transfers-table";
import { NotifyCardButton } from "./notify-card-button";

export default async function CardDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const t = await getTranslations("fund.cards.detail");
  const tList = await getTranslations("fund.cards");
  const tNotify = await getTranslations("cards.admin.notify");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const { id } = await params;
  const sp = await searchParams;

  const card = await prisma.card.findFirst({
    where: { id, fundId: fund.id },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          primaryCardId: true,
        },
      },
    },
  });

  if (!card) notFound();

  // Status of the "your card is on its way" notification for this (card,
  // member) pair — drives the notify prompt + "notified" badge below.
  const notifyEmail = card.memberId
    ? await prisma.email.findFirst({
        where: {
          cardId: card.id,
          memberId: card.memberId,
          type: "CARD_ASSIGNED",
        },
        orderBy: { queuedAt: "desc" },
        select: { status: true },
      })
    : null;

  const memberName = card.member
    ? `${card.member.firstName} ${card.member.lastName}`.trim()
    : "";
  const holderLabel = card.holderName || memberName || card.serialNumber;
  const isPrimary = card.member?.primaryCardId === card.id;
  const isLost = card.reportedLostAt !== null;
  const canShowBalance =
    fund.tokenAddress != null &&
    fund.tokenDecimals != null &&
    card.account != null;

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/cards"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </Link>
        <CardRowActions
          cardId={card.id}
          status={card.status}
          isLost={isLost}
          holderLabel={holderLabel}
          hasAccount={card.account !== null}
          tokenSymbol={fund.tokenSymbol}
          tokenDecimals={fund.tokenDecimals}
        />
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-medium">{holderLabel}</h1>
          <StatusBadge status={card.status} />
          {isLost && <Badge variant="warning">{tList("badges.lost")}</Badge>}
          {isPrimary && <Badge variant="outline">{tList("primary")}</Badge>}
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {card.serialNumber}
        </p>
      </header>

      <section className="grid gap-3 lg:grid-cols-[1fr_1.5fr]">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("balance.title")}</CardTitle>
            <CardDescription>{t("balance.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            {canShowBalance ? (
              <Suspense
                fallback={
                  <span className="inline-block h-7 w-32 animate-pulse rounded bg-muted" />
                }
              >
                <BalanceDisplay
                  chainId={fund.tokenChainId}
                  contractAddress={fund.tokenAddress!}
                  account={card.account!}
                  decimals={fund.tokenDecimals!}
                  symbol={fund.tokenSymbol}
                />
              </Suspense>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("balance.unavailable")}
              </p>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("info.title")}</CardTitle>
            <CardDescription>{t("info.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <DtDd label={t("info.serial")} mono>
                {card.serialNumber}
              </DtDd>
              <DtDd label={t("info.number")}>
                <CardNumberEdit cardId={card.id} initial={card.number} />
              </DtDd>
              <DtDd label={t("info.holder")}>{card.holderName ?? "—"}</DtDd>
              <DtDd label={t("info.member")}>
                {card.member ? (
                  <Link
                    href={`/members/${card.member.id}`}
                    className="hover:underline"
                  >
                    {memberName}
                  </Link>
                ) : (
                  "—"
                )}
              </DtDd>
              {card.memberId && (
                <DtDd label={tNotify("rowLabel")}>
                  {card.member?.email == null ? (
                    <span className="text-muted-foreground">
                      {tNotify("noEmail")}
                    </span>
                  ) : (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {notifyEmail?.status === "SENT" ? (
                        <>
                          <Badge variant="success">
                            {tNotify("status.sent")}
                          </Badge>
                          <NotifyCardButton
                            cardId={card.id}
                            memberName={memberName || holderLabel}
                            mode="resend"
                          />
                        </>
                      ) : notifyEmail?.status === "FAILED" ? (
                        <>
                          <Badge variant="destructive">
                            {tNotify("status.failed")}
                          </Badge>
                          <NotifyCardButton
                            cardId={card.id}
                            memberName={memberName || holderLabel}
                            mode="retry"
                          />
                        </>
                      ) : (
                        <>
                          <Badge variant="outline">
                            {tNotify("status.unsent")}
                          </Badge>
                          <NotifyCardButton
                            cardId={card.id}
                            memberName={memberName || holderLabel}
                            mode="send"
                          />
                        </>
                      )}
                    </span>
                  )}
                </DtDd>
              )}
              {card.memberId && (
                <DtDd label={t("onboardingLetter.rowLabel")}>
                  <a
                    href={`/api/cards/${card.id}/onboarding-letter`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <Download className="size-3.5" />
                    {t("onboardingLetter.download")}
                  </a>
                </DtDd>
              )}
              <DtDd label={t("info.account")}>
                {card.account ? (
                  <span className="inline-flex items-center gap-1">
                    <span
                      className="font-mono text-xs"
                      title={card.account}
                    >
                      {shortAddress(card.account)}
                    </span>
                    <CopyButton value={card.account} />
                  </span>
                ) : (
                  "—"
                )}
              </DtDd>
              {fund.citizenPayFundId && (
                <DtDd label={t("info.source")}>
                  <Suspense
                    fallback={
                      <span className="inline-block h-7 w-40 animate-pulse rounded bg-muted" />
                    }
                  >
                    <CardSourceRow
                      fund={{
                        id: fund.id,
                        citizenPayApiKeyId: fund.citizenPayApiKeyId,
                        citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
                      }}
                      cardId={card.id}
                      serialNumber={card.serialNumber}
                    />
                  </Suspense>
                </DtDd>
              )}
              <DtDd label={t("info.issued")}>
                {card.issuedAt
                  ? format.dateTime(card.issuedAt, { dateStyle: "medium" })
                  : "—"}
              </DtDd>
              {card.blockedAt && (
                <DtDd label={t("info.blocked")}>
                  {format.dateTime(card.blockedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </DtDd>
              )}
              {card.reportedLostAt && (
                <DtDd label={t("info.reportedLost")}>
                  {format.dateTime(card.reportedLostAt, {
                    dateStyle: "medium",
                  })}
                </DtDd>
              )}
              {card.lastTransactionAt && (
                <DtDd label={t("info.lastTransaction")}>
                  {format.dateTime(card.lastTransactionAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </DtDd>
              )}
            </dl>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("transfers.title")}
        </h2>
        {fund.tokenAddress == null || card.account == null ? (
          <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground">
            {t("transfers.unavailable")}
          </div>
        ) : (
          <Suspense
            key={`transfers:${sp.cursor ?? ""}`}
            fallback={
              <TableSkeleton
                columns={[
                  { label: t("transfers.date") },
                  { label: t("transfers.from") },
                  { width: "w-6" },
                  { label: t("transfers.to") },
                  { label: t("transfers.amount"), align: "right" },
                ]}
              />
            }
          >
            <CardTransfersTable
              fund={{
                id: fund.id,
                citizenPayApiKeyId: fund.citizenPayApiKeyId,
                citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
              }}
              contractAddress={fund.tokenAddress}
              chainId={fund.tokenChainId}
              decimals={fund.tokenDecimals ?? 0}
              symbol={fund.tokenSymbol}
              minterEoa={fund.tokenMinterEoaAddress}
              minterSmartAccount={fund.tokenMinterSmartAccountAddress}
              account={card.account}
              cursor={sp.cursor ?? null}
            />
          </Suspense>
        )}
      </section>
    </>
  );
}

async function BalanceDisplay({
  chainId,
  contractAddress,
  account,
  decimals,
  symbol,
}: {
  chainId: number;
  contractAddress: string;
  account: string;
  decimals: number;
  symbol: string | null;
}) {
  let rawBalance: string | null = null;
  try {
    const balances = await getBalances({
      chainId,
      contractAddress,
      addresses: [account],
    });
    rawBalance = balances[0]?.rawBalance ?? null;
  } catch (e) {
    console.warn("[cards.detail] balance fetch failed", e);
  }

  const formatted =
    rawBalance != null ? formatTokenAmount(rawBalance, decimals) : null;

  return (
    <div className="flex items-baseline gap-2">
      <Coins className="size-5 self-center text-muted-foreground" />
      <span className="font-heading text-3xl font-medium tabular-nums">
        {formatted ?? "—"}
      </span>
      {symbol && formatted && (
        <span className="text-sm text-muted-foreground">{symbol}</span>
      )}
    </div>
  );
}

// The card's configured source card (pull-from card at charge time). The
// relationship lives on CitizenPay — read live here, set via the inline
// picker. Candidate list comes from the local mirror (every fund card except
// this one), labelled by number + holder.
async function CardSourceRow({
  fund,
  cardId,
  serialNumber,
}: {
  fund: {
    id: string;
    citizenPayApiKeyId: string | null;
    citizenPayApiKeyEnc: string | null;
  };
  cardId: string;
  serialNumber: string;
}) {
  let sourceSerial: string | null = null;
  try {
    sourceSerial = await getCitizenPayClient(fund).getCardSource(serialNumber);
  } catch (e) {
    console.warn("[cards.detail] getCardSource failed", e);
    return <span className="text-muted-foreground">—</span>;
  }

  const candidates = await prisma.card.findMany({
    where: { fundId: fund.id, id: { not: cardId } },
    orderBy: [{ number: "asc" }, { serialNumber: "asc" }],
    select: {
      id: true,
      serialNumber: true,
      number: true,
      holderName: true,
      member: { select: { firstName: true, lastName: true } },
    },
  });

  const options = candidates.map((c) => {
    const holder =
      c.holderName ||
      (c.member ? `${c.member.firstName} ${c.member.lastName}`.trim() : "");
    const num = c.number !== null ? `#${c.number}` : null;
    return {
      id: c.id,
      label:
        [num, holder].filter(Boolean).join(" · ") || c.serialNumber,
    };
  });

  const current = sourceSerial
    ? (candidates.find((c) => c.serialNumber === sourceSerial) ?? null)
    : null;

  return (
    <CardSourcePicker
      cardId={cardId}
      currentSourceCardId={current?.id ?? null}
      unresolvedSourceSerial={sourceSerial && !current ? sourceSerial : null}
      options={options}
    />
  );
}

function DtDd({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : undefined}>{children}</dd>
    </>
  );
}

function StatusBadge({ status }: { status: CardStatusEnum }) {
  if (status === "ACTIVE") return <Badge variant="success">{status}</Badge>;
  if (status === "BLOCKED")
    return <Badge variant="destructive">{status}</Badge>;
  return <Badge>{status}</Badge>;
}
