import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { TableSkeleton } from "@/components/table-skeleton";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { contributionApplies } from "@/services/member/contribution";
import type { ExtraValue } from "@/services/member/schema";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { parseVisibleIf } from "@/services/onboarding/visibility";

import { UnassignCardButton } from "../../cards/unassign-card-button";
import { AddCardDialog } from "../add-card-dialog";
import { MemberRowActions } from "../member-row-actions";
import { StatusChangeDialog } from "../status-change-dialog";
import { MemberTierPicker } from "../tier-picker";
import { EditApplicationDataDialog } from "./edit-application-data-dialog";
import { EditProfileDialog } from "./edit-profile-dialog";
import { MintDialog } from "./mint-dialog";
import { ReminderOptOutToggle } from "./reminder-opt-out-toggle";

// Synchronous shell so the route paints its skeleton instantly; the member
// (params-dependent, uncached) streams in behind <Suspense>.
export default function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<MemberDetailSkeleton />}>
      <MemberDetail params={params} />
    </Suspense>
  );
}

async function MemberDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("fund.members.detail");
  const tStatus = await getTranslations("members.admin.status.values");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const { id } = await params;

  const member = await prisma.member.findFirst({
    where: { id, fundId: fund.id },
    include: {
      tier: {
        select: {
          id: true,
          name: true,
          allocationAmount: true,
          minContribution: true,
        },
      },
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
      select: {
        id: true,
        key: true,
        label: true,
        helpText: true,
        type: true,
        required: true,
        config: true,
        visibleIf: true,
        archivedAt: true,
      },
    }),
  ]);

  // Only questions the fund still asks are editable. Answers to archived ones
  // stay listed below (and are preserved by the action) but can't be changed —
  // editing a question that no longer exists on the form would be misleading.
  const editableFields = onboardingFields
    .filter((f) => f.archivedAt === null)
    .map((f) => {
      const config =
        (f.config as { options?: { value: string; label: string }[] } | null) ??
        null;
      return {
        id: f.id,
        key: f.key,
        type: f.type,
        label: f.label,
        helpText: f.helpText,
        required: f.required,
        options: config?.options ?? [],
        visibleIf: parseVisibleIf(f.visibleIf),
      };
    });

  // The commitment amount only applies to FIXED_PERIOD funds with tiers.
  const showContribution = contributionApplies(
    fund.allocationMode,
    tiers.length,
  );

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
          <EditProfileDialog
            memberId={member.id}
            member={{
              firstName: member.firstName,
              lastName: member.lastName,
              email: member.email,
              locale: member.locale,
              address: member.address,
              postalCode: member.postalCode,
              city: member.city,
              contributionAmount: member.contributionAmount?.toString() ?? null,
              notes: member.notes,
              tierTarget: member.tier?.allocationAmount.toString() ?? null,
              tierMin: member.tier?.minContribution.toString() ?? null,
            }}
            showContribution={showContribution}
          />
          {!member.primaryCardId &&
            (member.status === "NEW" || member.status === "ACTIVE") && (
              <MemberRowActions
                memberId={member.id}
                memberName={fullName}
                emailVerified={emailVerified}
                alreadyActive={member.status === "ACTIVE"}
              />
            )}
          {member.status === "ACTIVE" && member.primaryCard?.account && (
            <MintDialog memberId={member.id} memberName={fullName} />
          )}
          {member.status === "ACTIVE" && member.primaryCardId && (
            <AddCardDialog memberId={member.id} memberName={fullName} />
          )}
          <StatusChangeDialog
            memberId={member.id}
            memberName={fullName}
            currentStatus={member.status}
          />
        </div>
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-medium">{fullName}</h1>
          <StatusBadge status={member.status} label={tStatus(member.status)} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{member.email}</span>
          {!emailVerified && (
            <Badge variant="warning">{t("unverified")}</Badge>
          )}
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
              <DtDd label={t("profile.joined")}>
                {format.dateTime(member.joinedAt, { dateStyle: "medium" })}
              </DtDd>
              {member.leftAt && (
                <DtDd label={t("profile.left")}>
                  {format.dateTime(member.leftAt, { dateStyle: "medium" })}
                </DtDd>
              )}
              {member.notes && (
                <DtDd label={t("profile.notes")}>
                  <span className="whitespace-pre-wrap">{member.notes}</span>
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
              {showContribution && (
                <DtDd label={t("banking.committed")}>
                  {member.contributionAmount ? (
                    member.contributionAmount.toString()
                  ) : member.tier ? (
                    <span>
                      {member.tier.allocationAmount.toString()}{" "}
                      <span className="text-xs text-muted-foreground">
                        {t("banking.committedDefault")}
                      </span>
                    </span>
                  ) : (
                    "—"
                  )}
                </DtDd>
              )}
              <DtDd label={t("banking.primaryCard")} mono>
                {member.primaryCard?.account ??
                  member.primaryCard?.serialNumber ??
                  "—"}
              </DtDd>
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* Shown whenever the fund asks custom questions, even with no answers
          yet, so an admin can fill them in for a member who was imported or
          added by hand rather than through the public form. */}
      {((appData && Object.keys(appData).length > 0) ||
        editableFields.length > 0) && (
        <Card size="sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle>{t("applicationData.title")}</CardTitle>
                <CardDescription>
                  {t("applicationData.description")}
                </CardDescription>
              </div>
              {editableFields.length > 0 && (
                <EditApplicationDataDialog
                  memberId={member.id}
                  fields={editableFields}
                  values={(appData ?? {}) as Record<string, ExtraValue>}
                />
              )}
            </div>
          </CardHeader>
          <CardContent className="pb-3">
            {appData && Object.keys(appData).length > 0 ? (
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
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("applicationData.empty")}
              </p>
            )}
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
              <TableHead className="text-right">
                <span className="sr-only">{t("cards.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {member.cards.length === 0 ? (
              <TableEmpty colSpan={6}>{t("cards.empty")}</TableEmpty>
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
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`/api/cards/${c.id}/onboarding-letter`}
                          className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                          })}
                        >
                          <Download className="size-3.5" />
                          {t("cards.downloadLetter")}
                        </a>
                        <UnassignCardButton
                          cardId={c.id}
                          holderLabel={c.holderName ?? fullName}
                          isPrimary={isPrimary}
                        />
                      </div>
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

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("emails.title")}
        </h2>
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("emailSettings.title")}</CardTitle>
            <CardDescription>{t("emailSettings.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            <ReminderOptOutToggle
              memberId={member.id}
              initialUnsubscribed={member.emailUnsubscribed}
              unsubscribedSince={
                member.emailUnsubscribedAt
                  ? format.dateTime(member.emailUnsubscribedAt, {
                      dateStyle: "medium",
                    })
                  : null
              }
            />
          </CardContent>
        </Card>
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

function MemberDetailSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-4 w-24" />
        <div className="inline-flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <header className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </header>
      <section className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </section>
      <section className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <TableSkeleton columns={6} rows={3} alignRight={1} />
      </section>
      <section className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <TableSkeleton columns={6} rows={3} alignRight={1} />
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

function StatusBadge({ status, label }: { status: string; label: string }) {
  const variant: "default" | "success" | "warning" | "destructive" =
    status === "ACTIVE"
      ? "success"
      : status === "NEW" || status === "PAUSED"
        ? "warning"
        : status === "REJECTED"
          ? "destructive"
          : "default"; // INACTIVE, STOPPED
  return <Badge variant={variant}>{label}</Badge>;
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

function EmailStatusBadge({
  status,
}: {
  status: "QUEUED" | "SENT" | "FAILED";
}) {
  if (status === "SENT") return <Badge variant="success">{status}</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="warning">{status}</Badge>;
}
