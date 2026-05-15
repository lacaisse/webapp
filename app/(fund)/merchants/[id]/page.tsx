import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
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
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";

import { MerchantRowActions } from "../merchant-row-actions";

export default async function MerchantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("fund.merchants.detail");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const { id } = await params;

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
    select: { key: true, label: true },
  });

  const emailVerified = merchant.emailVerifiedAt !== null;
  const cpConnected = merchant.citizenPayActivatedAt !== null;
  const appData =
    (merchant.applicationData as Record<string, unknown> | null) ?? null;
  const payoutsTotal = merchant.bankTransactions.reduce(
    (acc, b) => acc + Number(b.amount),
    0,
  );

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
          emailVerified={emailVerified}
          status={merchant.status}
        />
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-medium">{merchant.name}</h1>
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
        </div>
        {merchant.description && (
          <p className="text-sm text-muted-foreground">{merchant.description}</p>
        )}
      </header>

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
              <DtDd label={t("business.conditions")}>
                {merchant.conditions ?? "—"}
              </DtDd>
              <DtDd label={t("business.citizenPayPlace")} mono>
                {merchant.citizenPayPlaceId ?? "—"}
              </DtDd>
              <DtDd label={t("business.citizenPayActivated")}>
                {merchant.citizenPayActivatedAt
                  ? format.dateTime(merchant.citizenPayActivatedAt, {
                      dateStyle: "medium",
                    })
                  : "—"}
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
                return (
                  <DtDd key={key} label={field?.label ?? key}>
                    {formatAppValue(value)}
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

function formatAppValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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
