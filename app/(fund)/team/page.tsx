// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import type { InvitableRole } from "@/services/fund-team/schema";
import { InviteMemberDialog } from "./invite-member-dialog";
import { InviteRowActions } from "./invite-row-actions";
import { MemberRowActions } from "./member-row-actions";

export default async function TeamPage() {
  const t = await getTranslations("fund.team");
  const roleLabel = await getTranslations("team.roles");
  const format = await getFormatter();
  // The (fund) layout already requires ADMIN; we re-resolve here to read the
  // actor's own role, which drives what they're allowed to grant.
  const { fund, user, membership } = await requireFundRole("ADMIN");

  const [staff, invites] = await Promise.all([
    prisma.fundMember.findMany({
      where: { fundId: fund.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.fundInvite.findMany({
      where: { fundId: fund.id, acceptedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        invitedBy: { select: { name: true, email: true } },
      },
    }),
  ]);

  const grantableRoles: InvitableRole[] =
    membership.role === "OWNER" ? ["OWNER", "ADMIN"] : ["ADMIN"];
  const ownerCount = staff.filter((s) => s.role === "OWNER").length;

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <InviteMemberDialog
          triggerLabel={t("invite")}
          grantableRoles={grantableRoles}
        />
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("staffHeading")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.email")}</TableHead>
              <TableHead>{t("columns.role")}</TableHead>
              <TableHead>{t("columns.joined")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {staff.map((s) => {
              const isOwnerTarget = s.role === "OWNER";
              // ADMIN actors can't touch an OWNER row at all.
              const canModify = !(isOwnerTarget && membership.role !== "OWNER");
              // Never remove (or demote) the last OWNER.
              const canRemove =
                canModify && !(isOwnerTarget && ownerCount <= 1);
              const name = s.user.name?.trim() || s.user.email;
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    {name}
                    {s.user.id === user.id && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t("you")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{s.user.email}</TableCell>
                  <TableCell>
                    <RoleBadge role={s.role} label={roleLabel(s.role)} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(s.createdAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="text-right">
                    <MemberRowActions
                      membershipId={s.id}
                      memberName={name}
                      currentRole={s.role}
                      grantableRoles={grantableRoles}
                      canModify={canModify}
                      canRemove={canRemove}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("pendingHeading")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.email")}</TableHead>
              <TableHead>{t("columns.role")}</TableHead>
              <TableHead>{t("columns.invitedBy")}</TableHead>
              <TableHead>{t("columns.expires")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.length === 0 ? (
              <TableEmpty colSpan={5}>{t("noPending")}</TableEmpty>
            ) : (
              invites.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-medium">{inv.email}</TableCell>
                  <TableCell>
                    <RoleBadge role={inv.role} label={roleLabel(inv.role)} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {inv.invitedBy?.name?.trim() ||
                      inv.invitedBy?.email ||
                      "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(inv.expiresAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="text-right">
                    <InviteRowActions inviteId={inv.id} email={inv.email} />
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

function RoleBadge({ role, label }: { role: string; label: string }) {
  const variant: "default" | "success" | "warning" =
    role === "OWNER" ? "success" : role === "ADMIN" ? "default" : "warning";
  return <Badge variant={variant}>{label}</Badge>;
}
