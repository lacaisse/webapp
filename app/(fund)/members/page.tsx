import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MemberStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { AddCardDialog } from "./add-card-dialog";
import { InviteMemberDialog } from "./invite-member-dialog";
import { MemberRowActions } from "./member-row-actions";
import { StatusChangeDialog } from "./status-change-dialog";
import { MemberTierPicker } from "./tier-picker";

const TABS = [
  { value: "all" },
  { value: "pending" },
  { value: "active" },
  { value: "inactive" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

// Tab → status filter. "pending" merges INVITED (admin added, no form yet)
// and ONBOARDING (form submitted, no card yet) since both share the same
// admin action: issue a card to activate.
function statusFilterFor(tab: TabValue) {
  switch (tab) {
    case "all":
      return undefined;
    case "pending":
      return { in: [MemberStatus.INVITED, MemberStatus.ONBOARDING] };
    case "active":
      return MemberStatus.ACTIVE;
    case "inactive":
      return { in: [MemberStatus.INACTIVE, MemberStatus.LEFT] };
  }
}

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.members");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  const status = statusFilterFor(active);
  const [members, tiers] = await Promise.all([
    prisma.member.findMany({
      where: { fundId: fund.id, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      include: {
        tier: { select: { name: true } },
        _count: { select: { cards: true } },
      },
    }),
    prisma.allocationTier.findMany({
      where: { fundId: fund.id, archivedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <InviteMemberDialog triggerLabel={t("invite")} />
      </header>

      <Tabs
        active={active}
        items={TABS.map((tab) => ({
          value: tab.value,
          label: t(`tabs.${tab.value}`),
        }))}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead>{t("columns.email")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead>{t("columns.tier")}</TableHead>
            <TableHead>{t("columns.cards")}</TableHead>
            <TableHead>{t("columns.joined")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.length === 0 ? (
            <TableEmpty colSpan={7}>{t("empty")}</TableEmpty>
          ) : (
            members.map((m) => {
              const fullName = `${m.firstName} ${m.lastName}`.trim();
              return (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{fullName}</TableCell>
                  <TableCell>
                    <div className="text-sm">{m.email}</div>
                    {!m.emailVerifiedAt && (
                      <div className="text-xs text-warning">
                        {t("unverified")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={m.status} />
                  </TableCell>
                  <TableCell>
                    <MemberTierPicker
                      memberId={m.id}
                      currentTierId={m.tierId}
                      tiers={tiers}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {m._count.cards}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(m.joinedAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1">
                      {(m.status === "INVITED" ||
                        m.status === "ONBOARDING") &&
                        !m.primaryCardId && (
                          <MemberRowActions
                            memberId={m.id}
                            memberName={fullName}
                            emailVerified={m.emailVerifiedAt !== null}
                          />
                        )}
                      {m.status === "ACTIVE" && m.primaryCardId && (
                        <AddCardDialog
                          memberId={m.id}
                          memberName={fullName}
                        />
                      )}
                      {(m.status === "ACTIVE" ||
                        m.status === "INACTIVE" ||
                        m.status === "LEFT") && (
                        <StatusChangeDialog
                          memberId={m.id}
                          memberName={fullName}
                          currentStatus={m.status}
                        />
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </>
  );
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
