import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { TableSkeleton } from "@/components/table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatTokenAmount, isZeroAddress } from "@/services/alchemy/format";
import { listTransfersForAccount } from "@/services/alchemy/transfers";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import { requireFundRole } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";
import { formatOnboardingAnswer } from "@/services/onboarding/format";

import { AddressLabel, buildAddressDirectory } from "../../token/address-label";
import { getPlacesForFund, getProfile } from "../../token/data";
import { EditMerchantName } from "../edit-merchant-name";
import { MerchantRowActions } from "../merchant-row-actions";
import { MerchantVisibilityToggle } from "../merchant-visibility-toggle";

// On-chain transfer history paginates 20 per page via the dual-stream cursor
// from listTransfersForAccount — same scheme as the card detail page and the
// token explorer. The cursor lives in the URL (?cursor=…) so back/forward and
// shareable links work.
const TRANSFERS_PAGE_SIZE = 20;

// Synchronous shell so the route paints its skeleton instantly; the merchant
// (params-dependent, uncached) streams in behind <Suspense>, and the heavy
// on-chain transfer history streams in its own nested boundary below.
export default function MerchantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  return (
    <Suspense fallback={<MerchantDetailSkeleton />}>
      <MerchantDetail params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function MerchantDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  await requireFundRole("ADMIN");
  const t = await getTranslations("fund.merchants.detail");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const { id } = await params;
  const { cursor } = await searchParams;

  const merchant = await prisma.merchant.findFirst({
    where: { id, fundId: fund.id },
    include: {
      reviewer: { select: { name: true, email: true } },
      bankTransactions: {
        where: { direction: "OUTGOING" },
        orderBy: { occurredAt: "desc" },
        take: 100,
      },
      emails: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });

  if (!merchant) notFound();

  const onboardingFields = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MERCHANT" },
    orderBy: [{ archivedAt: "asc" }, { position: "asc" }],
    select: { key: true, label: true, type: true, config: true },
  });

  const emailVerified = merchant.emailVerifiedAt !== null;
  const cpConnected = merchant.citizenPayActivatedAt !== null;
  const appData =
    (merchant.applicationData as Record<string, unknown> | null) ?? null;
  const payoutsTotal = merchant.bankTransactions.reduce(
    (acc, b) => acc + Number(b.amount),
    0,
  );

  // Live CitizenPay balance for this merchant's place. Mirrors
  // merchants-table.tsx: one listPlaces() call, find this place by id, read
  // its balanceCents. Degrade silently on failure (mock mode, CP down) — the
  // balance line just renders "unavailable".
  let placeBalanceCents: number | null = null;
  let cpBalanceUnavailable = false;
  if (merchant.citizenPayPlaceId) {
    try {
      const { places } = await getCitizenPayClient(fund).listPlaces();
      const place = places.find((p) => p.id === merchant.citizenPayPlaceId);
      placeBalanceCents = place?.balanceCents ?? null;
    } catch (e) {
      console.warn("[merchant-detail] listPlaces failed", e);
      cpBalanceUnavailable = true;
    }
  }

  // Token identity must be fully cached before on-chain transfers can be read.
  // The heavy Alchemy + CP-profile fetching is deferred to
  // <MerchantTransfersSection> so it streams in its own <Suspense> boundary
  // rather than blocking the rest of the merchant detail.
  const tokenReady =
    Boolean(fund.tokenAddress) &&
    typeof fund.tokenChainId === "number" &&
    typeof fund.tokenDecimals === "number" &&
    Boolean(fund.tokenSymbol);
  const transferAccount = merchant.citizenPayPlaceAccount;
  const showTransfers = tokenReady && Boolean(transferAccount);

  const coords =
    merchant.latitude !== null && merchant.longitude !== null
      ? { lat: merchant.latitude, lng: merchant.longitude }
      : null;
  const mapsUrl = coords
    ? `https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lng}#map=16/${coords.lat}/${coords.lng}`
    : null;

  const invitePendingState =
    merchant.status === "PENDING" && merchant.citizenPayInviteEmail !== null;

  // Server component: renders once per request, so reading the clock here is
  // safe. The react-hooks/purity rule targets client re-renders.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const invitePending =
    merchant.citizenPayInviteToken !== null &&
    (merchant.citizenPayInviteExpiresAt?.getTime() ?? 0) > nowMs;

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/merchants"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </Link>
        <MerchantRowActions
          merchantId={merchant.id}
          merchantName={merchant.name}
          merchantEmail={merchant.email}
          emailVerified={emailVerified}
          status={merchant.status}
          connected={merchant.citizenPayBusinessId !== null}
          invitePending={invitePending}
        />
      </div>

      <header className="flex items-start gap-4">
        {merchant.logoUrl && (
          // Merchant-supplied arbitrary URL — use a plain <img> rather than
          // next/image so we don't have to allowlist every possible host in
          // next.config (and we don't route untrusted URLs through the optimizer).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={merchant.logoUrl}
            alt=""
            width={56}
            height={56}
            className="size-14 shrink-0 rounded-lg border object-cover"
          />
        )}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-heading text-2xl font-medium">
              {merchant.name}
            </h1>
            <EditMerchantName
              merchantId={merchant.id}
              currentName={merchant.name}
            />
            <StatusBadge status={merchant.status} />
            {emailVerified ? (
              <Badge variant="success">{t("verified")}</Badge>
            ) : (
              <Badge variant="warning">{t("unverified")}</Badge>
            )}
            {cpConnected ? (
              <Badge variant="success">{t("connected")}</Badge>
            ) : (
              <Badge>{t("notConnected")}</Badge>
            )}
            {!merchant.publiclyVisible && (
              <Badge variant="warning">{t("hidden")}</Badge>
            )}
          </div>
          {merchant.description && (
            <p className="text-sm text-muted-foreground">
              {merchant.description}
            </p>
          )}
        </div>
      </header>

      {invitePendingState && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("invite.title")}</CardTitle>
            <CardDescription>{t("invite.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-3 text-sm">
            <p>
              {t("invite.sentTo", {
                email: merchant.citizenPayInviteEmail ?? "",
              })}
              {merchant.citizenPayInviteSentAt &&
                ` ${t("invite.on", {
                  date: format.dateTime(merchant.citizenPayInviteSentAt, {
                    dateStyle: "medium",
                  }),
                })}`}
              .
            </p>
            {merchant.citizenPayInviteExpiresAt && (
              <p className="mt-1 text-muted-foreground">
                {t("invite.expires", {
                  date: format.dateTime(merchant.citizenPayInviteExpiresAt, {
                    dateStyle: "medium",
                  }),
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <section className="grid gap-3 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("contact.title")}</CardTitle>
            <CardDescription>{t("contact.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <DtDd label={t("contact.contactName")}>
                {merchant.contactName ?? "—"}
              </DtDd>
              <DtDd label={t("contact.email")}>{merchant.email ?? "—"}</DtDd>
              <DtDd label={t("contact.phone")}>{merchant.phone ?? "—"}</DtDd>
              <DtDd label={t("contact.website")}>
                {merchant.website ? (
                  <a
                    href={merchant.website}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:underline"
                  >
                    {merchant.website}
                  </a>
                ) : (
                  "—"
                )}
              </DtDd>
              <DtDd label={t("contact.address")}>
                {formatAddress(
                  merchant.address,
                  merchant.postalCode,
                  merchant.city,
                  merchant.country,
                )}
              </DtDd>
              {mapsUrl && coords && (
                <DtDd label={t("contact.location")}>
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 hover:underline"
                  >
                    {t("contact.coordinates", {
                      lat: coords.lat,
                      lng: coords.lng,
                    })}
                    <ExternalLink className="size-3" />
                  </a>
                </DtDd>
              )}
              {merchant.emailVerifiedAt && (
                <DtDd label={t("contact.emailVerifiedAt")}>
                  {format.dateTime(merchant.emailVerifiedAt, {
                    dateStyle: "medium",
                  })}
                </DtDd>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("business.title")}</CardTitle>
            <CardDescription>{t("business.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <DtDd label={t("business.joined")}>
                {format.dateTime(merchant.joinedAt, { dateStyle: "medium" })}
              </DtDd>
              <DtDd label={t("business.position")}>{merchant.position}</DtDd>
              <DtDd label={t("business.publiclyVisible")}>
                <MerchantVisibilityToggle
                  merchantId={merchant.id}
                  initialVisible={merchant.publiclyVisible}
                />
              </DtDd>
              <DtDd label={t("business.conditions")}>
                {merchant.conditions ?? "—"}
              </DtDd>
              <DtDd label={t("business.citizenPayPlace")} mono>
                {merchant.citizenPayPlaceId ?? "—"}
              </DtDd>
              {merchant.citizenPayBusinessId && (
                <DtDd label={t("business.citizenPayBusiness")} mono>
                  {merchant.citizenPayBusinessId}
                </DtDd>
              )}
              {merchant.citizenPayPlaceAccount && (
                <DtDd label={t("business.citizenPayWallet")} mono>
                  {merchant.citizenPayPlaceAccount}
                </DtDd>
              )}
              {merchant.citizenPayPlaceId && (
                <DtDd label={t("business.balance")}>
                  {cpBalanceUnavailable ? (
                    <span className="text-muted-foreground">
                      {t("business.balanceUnavailable")}
                    </span>
                  ) : placeBalanceCents !== null ? (
                    <span className="tabular-nums">
                      {(placeBalanceCents / 100).toFixed(2)}
                      {fund.tokenSymbol && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          {fund.tokenSymbol}
                        </span>
                      )}
                    </span>
                  ) : (
                    "—"
                  )}
                </DtDd>
              )}
              <DtDd label={t("business.citizenPayActivated")}>
                {merchant.citizenPayActivatedAt
                  ? format.dateTime(merchant.citizenPayActivatedAt, {
                      dateStyle: "medium",
                    })
                  : "—"}
              </DtDd>
              {merchant.citizenPayLastSyncedAt && (
                <DtDd label={t("business.citizenPayLastSynced")}>
                  {format.dateTime(merchant.citizenPayLastSyncedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </DtDd>
              )}
              <DtDd label={t("business.createdAt")}>
                {format.dateTime(merchant.createdAt, { dateStyle: "medium" })}
              </DtDd>
              <DtDd label={t("business.updatedAt")}>
                {format.dateTime(merchant.updatedAt, { dateStyle: "medium" })}
              </DtDd>
              {merchant.reviewedAt && (
                <DtDd label={t("business.reviewed")}>
                  {format.dateTime(merchant.reviewedAt, {
                    dateStyle: "medium",
                  })}
                  {merchant.reviewer?.name && ` · ${merchant.reviewer.name}`}
                </DtDd>
              )}
              {merchant.reviewNote && (
                <DtDd label={t("business.reviewNote")}>
                  {merchant.reviewNote}
                </DtDd>
              )}
            </dl>
          </CardContent>
        </Card>
      </section>

      {appData && Object.keys(appData).length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("applicationData.title")}</CardTitle>
            <CardDescription>
              {t("applicationData.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              {Object.entries(appData).map(([key, value]) => {
                const field = onboardingFields.find((f) => f.key === key);
                const config =
                  (field?.config as
                    | { options?: { value: string; label: string }[] }
                    | null) ?? null;
                return (
                  <DtDd key={key} label={field?.label ?? key}>
                    {formatOnboardingAnswer(
                      value,
                      field
                        ? { type: field.type, options: config?.options ?? [] }
                        : undefined,
                    )}
                  </DtDd>
                );
              })}
            </dl>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <h2 className="font-heading text-lg font-medium">
            {t("payouts.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("payouts.total", {
              total: payoutsTotal.toFixed(2),
              count: merchant.bankTransactions.length,
            })}
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("payouts.date")}</TableHead>
              <TableHead>{t("payouts.reference")}</TableHead>
              <TableHead className="text-right">
                {t("payouts.amount")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {merchant.bankTransactions.length === 0 ? (
              <TableEmpty colSpan={3}>{t("payouts.empty")}</TableEmpty>
            ) : (
              merchant.bankTransactions.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(b.occurredAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {b.counterpartReference ?? b.remittanceInfo ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {b.amount.toString()} {b.currency}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("emails.title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("emails.date")}</TableHead>
              <TableHead>{t("emails.type")}</TableHead>
              <TableHead>{t("emails.to")}</TableHead>
              <TableHead>{t("emails.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {merchant.emails.length === 0 ? (
              <TableEmpty colSpan={4}>{t("emails.empty")}</TableEmpty>
            ) : (
              merchant.emails.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(e.createdAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell className="text-sm">{e.type}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {e.toEmail}
                  </TableCell>
                  <TableCell>
                    <EmailStatusBadge status={e.status} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      {showTransfers && transferAccount && (
        <section className="space-y-3">
          <h2 className="font-heading text-lg font-medium">
            {t("transfers.title")}
          </h2>
          <Suspense
            key={cursor ?? "first"}
            fallback={<TableSkeleton columns={4} alignRight={1} />}
          >
            <MerchantTransfersSection
              fund={fund}
              account={transferAccount}
              cursor={cursor ?? null}
            />
          </Suspense>
        </section>
      )}
    </>
  );
}

// On-chain transfer history for this merchant's wallet, streamed in its own
// <Suspense> boundary. Reuses the token explorer's per-account transfers
// service + address directory so counterparties resolve to member/merchant
// names. Degrades silently on any failure (Alchemy unconfigured / down).
async function MerchantTransfersSection({
  fund,
  account: transferAccount,
  cursor,
}: {
  fund: Awaited<ReturnType<typeof requireCurrentFund>>;
  account: string;
  cursor: string | null;
}) {
  const t = await getTranslations("fund.merchants.detail");
  const tAcc = await getTranslations("fund.accounts");
  const format = await getFormatter();

  let transferRows: Array<{
    uniqueId: string;
    blockTimestamp: string | null;
    direction: "in" | "out";
    counterparty: string;
    rawValue: string;
  }> = [];
  let transferDirectory: ReturnType<typeof buildAddressDirectory> | null = null;
  let transfersNextPageKey: string | null = null;
  let transfersUnavailable = false;

  try {
    const account = transferAccount.toLowerCase();
    const [page, cards, placesResult, merchants, tokenAccounts] =
      await Promise.all([
        listTransfersForAccount({
          chainId: fund.tokenChainId!,
          contractAddress: fund.tokenAddress!,
          account: transferAccount,
          pageSize: TRANSFERS_PAGE_SIZE,
          cursor: cursor ?? null,
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

    const merchantNameByPlaceId = new Map<string, string>();
    for (const m of merchants) {
      if (m.citizenPayPlaceId)
        merchantNameByPlaceId.set(m.citizenPayPlaceId, m.name);
    }

    // Addresses we can already label locally — skip the CP profile fetch.
    const knownLocal = new Set<string>();
    for (const c of cards)
      if (c.account) knownLocal.add(c.account.toLowerCase());
    for (const p of placesResult)
      if (p.account) knownLocal.add(p.account.toLowerCase());
    if (fund.tokenMinterEoaAddress)
      knownLocal.add(fund.tokenMinterEoaAddress.toLowerCase());
    if (fund.tokenMinterSmartAccountAddress)
      knownLocal.add(fund.tokenMinterSmartAccountAddress.toLowerCase());

    // Counterparties on this page that we can't label locally — resolve a
    // CP profile so they show a name instead of "Unknown".
    const unresolved = new Set<string>();
    for (const tx of page.transfers) {
      const counter = tx.from.toLowerCase() === account ? tx.to : tx.from;
      const lower = counter.toLowerCase();
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

    transferDirectory = buildAddressDirectory({
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
      minterEoa: fund.tokenMinterEoaAddress,
      minterSmartAccount: fund.tokenMinterSmartAccountAddress,
    });

    transferRows = page.transfers.map((tx) => {
      const isOut = tx.from.toLowerCase() === account;
      return {
        uniqueId: tx.uniqueId,
        blockTimestamp: tx.blockTimestamp,
        direction: isOut ? ("out" as const) : ("in" as const),
        counterparty: isOut ? tx.to : tx.from,
        rawValue: tx.rawValue,
      };
    });

    transfersNextPageKey = page.nextPageKey;
  } catch (e) {
    console.warn("[merchant-detail] transfers fetch failed", e);
    transfersUnavailable = true;
  }

  if (transfersUnavailable) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground">
        {t("transfers.unavailable")}
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("transfers.date")}</TableHead>
            <TableHead>{t("transfers.direction")}</TableHead>
            <TableHead>{t("transfers.counterparty")}</TableHead>
            <TableHead className="text-right">{t("transfers.amount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transferRows.length === 0 || !transferDirectory ? (
            <TableEmpty colSpan={4}>{t("transfers.empty")}</TableEmpty>
          ) : (
            transferRows.map((tx) => (
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
                  {tx.direction === "in" ? (
                    <span className="inline-flex items-center gap-1.5 text-sm">
                      <ArrowDownLeft className="size-3.5 text-success" />
                      {t("transfers.in")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm">
                      <ArrowUpRight className="size-3.5 text-muted-foreground" />
                      {t("transfers.out")}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <AddressLabel
                    address={tx.counterparty}
                    directory={transferDirectory}
                    // The counterparty's role in the transfer is the opposite
                    // of the merchant's: an incoming transfer means the
                    // counterparty was the sender ("from").
                    side={tx.direction === "in" ? "from" : "to"}
                    labels={{
                      issued: t("transfers.issued"),
                      retired: t("transfers.retired"),
                      treasury: t("transfers.treasury"),
                      unknown: t("transfers.unknown"),
                    }}
                  />
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatTokenAmount(tx.rawValue, fund.tokenDecimals)}
                  {fund.tokenSymbol && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {fund.tokenSymbol}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <TransfersPager
        cursor={cursor ?? null}
        nextPageKey={transfersNextPageKey}
        labels={{
          newer: t("transfers.newer"),
          older: t("transfers.older"),
        }}
      />
    </>
  );
}

function MerchantDetailSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-28" />
      </div>
      <header className="flex items-start gap-4">
        <Skeleton className="size-14 shrink-0 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </header>
      <section className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </section>
      <section className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <TableSkeleton columns={3} rows={3} alignRight={1} />
      </section>
    </>
  );
}

// Cursor-only pager mirroring the card detail page. The merchant route has
// no other query params to preserve, so "Newer" drops the cursor (first page)
// and "Older" sets ?cursor=<nextPageKey>. Both render as <Link> so they're
// shareable and survive SSR. Forward-only — Alchemy's pageKey can't go back.
function TransfersPager({
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

function formatAddress(
  address: string | null,
  postalCode: string | null,
  city: string | null,
  country: string | null,
): string {
  const lineTwo = [postalCode, city, country].filter(Boolean).join(" ");
  const parts = [address, lineTwo].filter((p) => p && p.length > 0);
  return parts.length > 0 ? parts.join(", ") : "—";
}

function StatusBadge({ status }: { status: string }) {
  const variant: "default" | "success" | "warning" | "destructive" =
    status === "ACTIVE"
      ? "success"
      : status === "PENDING"
        ? "warning"
        : status === "REJECTED"
          ? "destructive"
          : "default";
  return <Badge variant={variant}>{status}</Badge>;
}

function EmailStatusBadge({
  status,
}: {
  status: "QUEUED" | "SENT" | "FAILED";
}) {
  if (status === "SENT") return <Badge variant="success">{status}</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="warning">{status}</Badge>;
}
