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

import { AddCardDialog } from "../add-card-dialog";
import { MemberRowActions } from "../member-row-actions";
import { StatusChangeDialog } from "../status-change-dialog";
import { MemberTierPicker } from "../tier-picker";
import { MintDialog } from "./mint-dialog";

export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("fund.members.detail");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const { id } = await params;

  const member = await prisma.member.findFirst({
    where: { id, fundId: fund.id },
    include: {
      tier: { select: { id: true, name: true } },
      primaryCard: {
        select: { id: true, serialNumber: true, account: true, status: true },
      },
      cards: { orderBy: { createdAt: "asc" } },
      tokenOperations: {
        orderBy: { submittedAt: "desc" },
        take: 50,
        include: {
          tier: { select: { name: true } },
          allocationPeriod: { select: { label: true } },
        },
      },
      bankTransactions: {
        orderBy: { occurredAt: "desc" },
        take: 50,
        include: { allocationPeriod: { select: { label: true } } },
      },
      sponsoredReferrals: {
        orderBy: { createdAt: "desc" },
        include: {
          referee: { select: { id: true, firstName: true, lastName: true } },
        },
      },
      referralRecord: {
        include: {
          sponsor: { select: { id: true, firstName: true, lastName: true } },
        },
      },
      emails: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });

  if (!member) notFound();

  const [tiers, onboardingFields] = await Promise.all([
    prisma.allocationTier.findMany({
      where: { fundId: fund.id, archivedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.onboardingField.findMany({
      where: { fundId: fund.id, target: "MEMBER" },
      orderBy: [{ archivedAt: "asc" }, { position: "asc" }],
      select: { key: true, label: true },
    }),
  ]);

  const fullName = `${member.firstName} ${member.lastName}`.trim();
  const emailVerified = member.emailVerifiedAt !== null;
  const appData =
    (member.applicationData as Record<string, unknown> | null) ?? null;

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/members"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </Link>
        <div className="inline-flex items-center gap-2">
          {(member.status === "INVITED" || member.status === "ONBOARDING") &&
            !member.primaryCardId && (
              <MemberRowActions
                memberId={member.id}
                memberName={fullName}
                emailVerified={emailVerified}
              />
            )}
          {member.status === "ACTIVE" && member.primaryCard?.account && (
            <MintDialog memberId={member.id} memberName={fullName} />
          )}
          {member.status === "ACTIVE" && member.primaryCardId && (
            <AddCardDialog memberId={member.id} memberName={fullName} />
          )}
          {(member.status === "ACTIVE" ||
            member.status === "INACTIVE" ||
            member.status === "LEFT") && (
            <StatusChangeDialog
              memberId={member.id}
              memberName={fullName}
              currentStatus={member.status}
            />
          )}
        </div>
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-medium">{fullName}</h1>
          <StatusBadge status={member.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{member.email}</span>
          {!emailVerified && (
            <Badge variant="warning">{t("unverified")}</Badge>
          )}
          {member.phone && <span>{member.phone}</span>}
        </div>
      </header>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("profile.title")}</CardTitle>
            <CardDescription>{t("profile.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <DtDd label={t("profile.address")}>
                {formatAddress(member.address, member.postalCode, member.city)}
              </DtDd>
              <DtDd label={t("profile.household")}>
                {t("profile.householdValue", {
                  adults: member.householdAdults,
                  children: member.householdChildren,
                })}
              </DtDd>
              <DtDd label={t("profile.joined")}>
                {format.dateTime(member.joinedAt, { dateStyle: "medium" })}
              </DtDd>
              {member.leftAt && (
                <DtDd label={t("profile.left")}>
                  {format.dateTime(member.leftAt, { dateStyle: "medium" })}
                </DtDd>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("banking.title")}</CardTitle>
            <CardDescription>{t("banking.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("banking.tier")}</dt>
              <dd>
                <MemberTierPicker
                  memberId={member.id}
                  currentTierId={member.tierId}
                  tiers={tiers}
                />
              </dd>
              <DtDd label={t("banking.iban")} mono>
                {member.iban ?? "—"}
              </DtDd>
              <DtDd label={t("banking.reference")} mono>
                {member.paymentReference ?? "—"}
              </DtDd>
              <DtDd label={t("banking.referralCode")} mono>
                {member.referralCode ?? "—"}
              </DtDd>
              <DtDd label={t("banking.primaryCard")} mono>
                {member.primaryCard?.account ??
                  member.primaryCard?.serialNumber ??
                  "—"}
              </DtDd>
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
        <h2 className="font-heading text-lg font-medium">
          {t("cards.title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("cards.serial")}</TableHead>
              <TableHead>{t("cards.holder")}</TableHead>
              <TableHead>{t("cards.status")}</TableHead>
              <TableHead>{t("cards.issued")}</TableHead>
              <TableHead className="text-right">{t("cards.balance")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {member.cards.length === 0 ? (
              <TableEmpty colSpan={5}>{t("cards.empty")}</TableEmpty>
            ) : (
              member.cards.map((c) => {
                const isPrimary = member.primaryCardId === c.id;
                const isLost = c.reportedLostAt !== null;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">
                      {c.serialNumber}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{c.holderName ?? fullName}</div>
                      {isPrimary && (
                        <div className="text-xs text-muted-foreground">
                          {t("cards.primary")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <CardStatusBadge status={c.status} />
                        {isLost && (
                          <Badge variant="warning">{t("cards.lost")}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.issuedAt
                        ? format.dateTime(c.issuedAt, { dateStyle: "medium" })
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {c.balance?.toString() ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("tokenOps.title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("tokenOps.date")}</TableHead>
              <TableHead>{t("tokenOps.type")}</TableHead>
              <TableHead>{t("tokenOps.tier")}</TableHead>
              <TableHead>{t("tokenOps.period")}</TableHead>
              <TableHead className="text-right">
                {t("tokenOps.amount")}
              </TableHead>
              <TableHead>{t("tokenOps.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {member.tokenOperations.length === 0 ? (
              <TableEmpty colSpan={6}>{t("tokenOps.empty")}</TableEmpty>
            ) : (
              member.tokenOperations.map((op) => (
                <TableRow key={op.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(op.submittedAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="text-sm">{op.type}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {op.tier?.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {op.allocationPeriod?.label ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {op.amount.toString()}
                  </TableCell>
                  <TableCell>
                    <OperationStatusBadge status={op.status} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("bank.title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("bank.date")}</TableHead>
              <TableHead>{t("bank.reference")}</TableHead>
              <TableHead>{t("bank.period")}</TableHead>
              <TableHead className="text-right">{t("bank.amount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {member.bankTransactions.length === 0 ? (
              <TableEmpty colSpan={4}>{t("bank.empty")}</TableEmpty>
            ) : (
              member.bankTransactions.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(b.occurredAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {b.counterpartReference ?? b.remittanceInfo ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {b.allocationPeriod?.label ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {b.direction === "OUTGOING" && "−"}
                    {b.amount.toString()} {b.currency}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("referrals.sponsorTitle")}</CardTitle>
            <CardDescription>
              {t("referrals.sponsorDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-3 text-sm">
            {member.referralRecord ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/members/${member.referralRecord.sponsor.id}`}
                  className="font-medium hover:underline"
                >
                  {`${member.referralRecord.sponsor.firstName} ${member.referralRecord.sponsor.lastName}`.trim()}
                </Link>
                <ReferralStatusBadge status={member.referralRecord.status} />
              </div>
            ) : (
              <p className="text-muted-foreground">
                {t("referrals.sponsorEmpty")}
              </p>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("referrals.sponsoredTitle")}</CardTitle>
            <CardDescription>
              {t("referrals.sponsoredDescription", {
                count: member.sponsoredReferrals.length,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            {member.sponsoredReferrals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("referrals.sponsoredEmpty")}
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {member.sponsoredReferrals.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <Link
                      href={`/members/${r.referee.id}`}
                      className="hover:underline"
                    >
                      {`${r.referee.firstName} ${r.referee.lastName}`.trim()}
                    </Link>
                    <ReferralStatusBadge status={r.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
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
            {member.emails.length === 0 ? (
              <TableEmpty colSpan={4}>{t("emails.empty")}</TableEmpty>
            ) : (
              member.emails.map((e) => (
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
): string {
  const parts = [address, [postalCode, city].filter(Boolean).join(" ")]
    .filter((p) => p && p.length > 0)
    .join(", ");
  return parts || "—";
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
      : status === "INVITED" || status === "ONBOARDING"
        ? "warning"
        : "default";
  return <Badge variant={variant}>{status}</Badge>;
}

function CardStatusBadge({
  status,
}: {
  status: "ACTIVE" | "INACTIVE" | "BLOCKED";
}) {
  if (status === "ACTIVE") return <Badge variant="success">{status}</Badge>;
  if (status === "BLOCKED")
    return <Badge variant="destructive">{status}</Badge>;
  return <Badge>{status}</Badge>;
}

function OperationStatusBadge({
  status,
}: {
  status: "PENDING" | "CONFIRMED" | "FAILED";
}) {
  if (status === "CONFIRMED") return <Badge variant="success">{status}</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="warning">{status}</Badge>;
}

function ReferralStatusBadge({
  status,
}: {
  status: "PENDING" | "ACTIVATED";
}) {
  if (status === "ACTIVATED") return <Badge variant="success">{status}</Badge>;
  return <Badge variant="warning">{status}</Badge>;
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
