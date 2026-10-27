// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Coins, Download, ExternalLink } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Sensitive } from "@/components/privacy/sensitive";
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
import { maskValue } from "@/lib/privacy";
import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount, shortAddress } from "@/services/alchemy/format";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { CardSourceInfo } from "@/services/citizenpay/types";
import { resolveTreasurySlug } from "@/services/citizenpay/treasury-slug";
import {
  type CardStatus as CardStatusEnum,
} from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { buildCardLink } from "@/services/email/templates";
import { requireCurrentFund } from "@/services/fund/server";
import { getPrivacyMode } from "@/services/privacy/server";

import { CardRowActions } from "../card-row-actions";
import { TableSkeleton } from "../../token/skeleton";
import { CardNumberEdit } from "./card-number-edit";
import { CardSourcePicker, type SourceOption } from "./source-picker";
import { CardTransfersTable } from "./transfers-table";
import { CardWeeklyLimitInput } from "./weekly-limit";
import { NotifyCardButton } from "./notify-card-button";
import { ChargeCardDialog } from "./charge-card-dialog";
import { TransferDialog } from "./transfer-dialog";
import { UnassignCardButton } from "../unassign-card-button";

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
  const privacy = await getPrivacyMode();
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
  // String props into client dialogs get the mask here; rendered values use
  // <Sensitive>.
  const holderDisplay = privacy ? maskValue("name") : holderLabel;
  const notifyName = privacy ? maskValue("name") : memberName || holderLabel;
  const isPrimary = card.member?.primaryCardId === card.id;
  const isLost = card.reportedLostAt !== null;
  const canShowBalance =
    fund.tokenAddress != null &&
    fund.tokenDecimals != null &&
    card.account != null;
  const tapLink = buildCardLink(card.serialNumber, await resolveTreasurySlug(fund));
  // Where the card can be charged for an uncollected sale: the fund's active
  // merchants connected to Citizen Pay. Empty hides nothing but disables the
  // button — the admin sees the feature exists.
  const chargeableMerchants =
    canShowBalance && card.status !== "BLOCKED"
      ? (
          await prisma.merchant.findMany({
            where: {
              fundId: fund.id,
              status: "ACTIVE",
              citizenPayPlaceId: { not: null },
            },
            orderBy: [{ position: "asc" }, { name: "asc" }],
            select: { id: true, name: true, citizenPayPlaceId: true },
          })
        ).map((m) => ({ id: m.id, name: m.name, placeId: m.citizenPayPlaceId! }))
      : null;

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
        <div className="flex flex-wrap items-center justify-end gap-2">
          {chargeableMerchants !== null && (
            <ChargeCardDialog
              cardId={card.id}
              serialNumber={card.serialNumber}
              holderLabel={holderDisplay}
              tokenSymbol={fund.tokenSymbol}
              merchants={chargeableMerchants}
            />
          )}
          {canShowBalance && (
            <TransferDialog
              cardId={card.id}
              holderLabel={holderDisplay}
              tokenSymbol={fund.tokenSymbol}
            />
          )}
          {card.memberId && (
            <UnassignCardButton
              cardId={card.id}
              holderLabel={holderDisplay}
              isPrimary={isPrimary}
            />
          )}
          <CardRowActions
            cardId={card.id}
            status={card.status}
            isLost={isLost}
            holderLabel={holderDisplay}
            hasAccount={card.account !== null}
            tokenSymbol={fund.tokenSymbol}
            tokenDecimals={fund.tokenDecimals}
          />
        </div>
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-medium">
            <Sensitive kind="name">{holderLabel}</Sensitive>
          </h1>
          <StatusBadge status={card.status} />
          {isLost && <Badge variant="warning">{tList("badges.lost")}</Badge>}
          {isPrimary && <Badge variant="outline">{tList("primary")}</Badge>}
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          <Sensitive kind="number">{card.serialNumber}</Sensitive>
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
                <Sensitive kind="number">{card.serialNumber}</Sensitive>
              </DtDd>
              <DtDd label={t("info.tapLink")}>
                <span className="inline-flex items-center gap-1">
                  <a
                    href={tapLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 hover:underline"
                  >
                    {t("info.tapLinkLabel")}
                    <ExternalLink className="size-3" />
                  </a>
                  <CopyButton value={tapLink} />
                </span>
              </DtDd>
              <DtDd label={t("info.number")}>
                <CardNumberEdit cardId={card.id} initial={card.number} />
              </DtDd>
              <DtDd label={t("info.holder")}>
                {card.holderName ? (
                  <Sensitive kind="name">{card.holderName}</Sensitive>
                ) : (
                  "—"
                )}
              </DtDd>
              <DtDd label={t("info.member")}>
                {card.member ? (
                  <Link
                    href={`/members/${card.member.id}`}
                    className="hover:underline"
                  >
                    <Sensitive kind="name">{memberName}</Sensitive>
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
                            memberName={notifyName}
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
                            memberName={notifyName}
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
                            memberName={notifyName}
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
                      title={privacy ? undefined : card.account}
                    >
                      <Sensitive kind="address">
                        {shortAddress(card.account)}
                      </Sensitive>
                    </span>
                    <CopyButton value={card.account} />
                  </span>
                ) : (
                  "—"
                )}
              </DtDd>
              {fund.citizenPayFundId && (
                <Suspense
                  fallback={
                    <>
                      <DtDd label={t("info.source")}>
                        <span className="inline-block h-7 w-40 animate-pulse rounded bg-muted" />
                      </DtDd>
                      <DtDd label={t("source.weeklyLimit.label")}>
                        <span className="inline-block h-7 w-24 animate-pulse rounded bg-muted" />
                      </DtDd>
                    </>
                  }
                >
                  <CardSourceRows
                    fund={{
                      id: fund.id,
                      citizenPayApiKeyId: fund.citizenPayApiKeyId,
                      citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
                    }}
                    cardId={card.id}
                    serialNumber={card.serialNumber}
                  />
                </Suspense>
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
        {formatted !== null ? (
          <Sensitive kind="amount">{formatted}</Sensitive>
        ) : (
          "—"
        )}
      </span>
      {symbol && formatted && (
        <span className="text-sm text-muted-foreground">{symbol}</span>
      )}
    </div>
  );
}

// What the card pulls from at charge time when its own balance falls short,
// and the weekly cap on those pulls. Source can be another fund card or a
// SOURCE token account — both referenced on CitizenPay by serial. Source, cap
// and this week's usage live on CP (read live here, set via the inline picker
// and limit input); source candidates come from the local mirror. Renders the
// "Source card" and "Weekly limit" rows of the info list.
async function CardSourceRows({
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
  const t = await getTranslations("fund.cards.detail");
  const format = await getFormatter();

  let info: CardSourceInfo;
  try {
    info = await getCitizenPayClient(fund).getCardSourceInfo(serialNumber);
  } catch (e) {
    console.warn("[cards.detail] getCardSourceInfo failed", e);
    return (
      <>
        <DtDd label={t("info.source")}>
          <span className="text-muted-foreground">—</span>
        </DtDd>
        <DtDd label={t("source.weeklyLimit.label")}>
          <span className="text-muted-foreground">—</span>
        </DtDd>
      </>
    );
  }
  const { sourceSerial, weeklyLimit, allowance } = info;

  const [cards, accounts] = await Promise.all([
    prisma.card.findMany({
      where: { fundId: fund.id, id: { not: cardId } },
      orderBy: [{ number: "asc" }, { serialNumber: "asc" }],
      select: {
        id: true,
        serialNumber: true,
        number: true,
        holderName: true,
        member: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.fundTokenAccount.findMany({
      where: {
        fundId: fund.id,
        kind: "SOURCE",
        archivedAt: null,
        serial: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, serial: true },
    }),
  ]);

  const options: SourceOption[] = [
    ...cards.map((c) => ({
      type: "card" as const,
      id: c.id,
      serial: c.serialNumber,
      number: c.number,
      name:
        c.holderName ||
        (c.member ? `${c.member.firstName} ${c.member.lastName}`.trim() : ""),
    })),
    ...accounts.map((a) => ({
      type: "account" as const,
      id: a.id,
      serial: a.serial!,
      number: null,
      name: a.name,
    })),
  ];

  const current = sourceSerial
    ? (options.find((o) => o.serial === sourceSerial) ?? null)
    : null;

  // Fund money, not personal data — amounts stay visible in privacy mode.
  const eur = (cents: number) =>
    format.number(cents / 100, { style: "currency", currency: "EUR" });

  return (
    <>
      <DtDd label={t("info.source")}>
        <CardSourcePicker
          cardId={cardId}
          currentRefId={current ? `${current.type}:${current.id}` : null}
          unresolvedSourceSerial={sourceSerial && !current ? sourceSerial : null}
          options={options}
        />
      </DtDd>
      <DtDd label={t("source.weeklyLimit.label")}>
        <div className="space-y-1">
          <CardWeeklyLimitInput
            // Remount on a server-side change so the input shows CP's value.
            key={`${weeklyLimit ?? "none"}:${sourceSerial ?? "none"}`}
            cardId={cardId}
            limitCents={weeklyLimit}
            hasSource={sourceSerial !== null}
          />
          {allowance && (
            <p
              className={
                allowance.remaining <= 0
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {t("source.weeklyLimit.usage", {
                spent: eur(allowance.spent),
                limit: eur(allowance.limit),
                // The week resets Monday 00:00 in Brussels; format it there so
                // a UTC server doesn't print "Sunday".
                resetsAt: format.dateTime(allowance.resetsAt, {
                  weekday: "long",
                  day: "numeric",
                  month: "short",
                  timeZone: "Europe/Brussels",
                }),
              })}
            </p>
          )}
        </div>
      </DtDd>
    </>
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
