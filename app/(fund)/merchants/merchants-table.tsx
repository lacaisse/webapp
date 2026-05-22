// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
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
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

import { MerchantRowActions } from "./merchant-row-actions";

// Async data fetch + table render for /merchants. Wrapped by a Suspense
// boundary in page.tsx so the shell streams immediately while the
// Prisma + CP listPlaces() round-trips complete in the background.

export type MerchantsTab = "pending" | "active" | "rejected" | "inactive";

const STATUS_BY_TAB = {
  pending: "PENDING",
  active: "ACTIVE",
  rejected: "REJECTED",
  inactive: "INACTIVE",
} as const;

export async function MerchantsTable({
  fund,
  tab,
}: {
  fund: {
    id: string;
    citizenPayApiKeyId: string | null;
    citizenPayApiKeyEnc: string | null;
    tokenSymbol: string | null;
  };
  tab: MerchantsTab;
}) {
  const t = await getTranslations("fund.merchants");
  const format = await getFormatter();

  const merchants = await prisma.merchant.findMany({
    where: { fundId: fund.id, status: STATUS_BY_TAB[tab] },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      contactName: true,
      status: true,
      emailVerifiedAt: true,
      citizenPayPlaceId: true,
      citizenPayBusinessId: true,
      citizenPayActivatedAt: true,
      citizenPayInviteToken: true,
      citizenPayInviteExpiresAt: true,
      reviewedAt: true,
      reviewNote: true,
      joinedAt: true,
    },
  });

  const now = Date.now();

  // CP-side balances. One listPlaces() returns every connected place for
  // this treasury with its current balance. Skip the call when no
  // visible merchant is connected. Degrade silently on failure — the
  // column just shows "—".
  const balanceByPlaceId = new Map<string, number>();
  const hasConnectedMerchants = merchants.some(
    (m) => m.citizenPayPlaceId !== null,
  );
  if (hasConnectedMerchants) {
    try {
      const { places } = await getCitizenPayClient(fund).listPlaces();
      for (const p of places) {
        if (p.balanceCents !== null) balanceByPlaceId.set(p.id, p.balanceCents);
      }
    } catch (e) {
      console.warn("[merchants] listPlaces failed", e);
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("columns.name")}</TableHead>
          <TableHead>{t("columns.contact")}</TableHead>
          <TableHead>{t("columns.emailVerified")}</TableHead>
          <TableHead>{t("columns.citizenpay")}</TableHead>
          <TableHead className="text-right">{t("columns.balance")}</TableHead>
          <TableHead>{t("columns.joined")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {merchants.length === 0 ? (
          <TableEmpty colSpan={7}>{t("empty")}</TableEmpty>
        ) : (
          merchants.map((m) => {
            const balanceCents = m.citizenPayPlaceId
              ? balanceByPlaceId.get(m.citizenPayPlaceId)
              : undefined;
            return (
              <TableRow key={m.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/merchants/${m.id}`}
                    className="hover:underline"
                  >
                    {m.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{m.contactName ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.email ?? "—"}
                  </div>
                </TableCell>
                <TableCell>
                  {m.emailVerifiedAt ? (
                    <Badge variant="success">{t("badges.verified")}</Badge>
                  ) : (
                    <Badge variant="warning">{t("badges.unverified")}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {m.citizenPayActivatedAt ? (
                    <Badge variant="success">{t("badges.connected")}</Badge>
                  ) : (
                    <Badge>{t("badges.notConnected")}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {balanceCents !== undefined ? (
                    <>
                      {(balanceCents / 100).toFixed(2)}
                      {fund.tokenSymbol && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          {fund.tokenSymbol}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(m.joinedAt, { dateStyle: "medium" })}
                </TableCell>
                <TableCell className="text-right">
                  <MerchantRowActions
                    merchantId={m.id}
                    merchantName={m.name}
                    merchantEmail={m.email}
                    emailVerified={m.emailVerifiedAt !== null}
                    status={m.status}
                    connected={m.citizenPayBusinessId !== null}
                    invitePending={
                      m.citizenPayInviteToken !== null &&
                      (m.citizenPayInviteExpiresAt?.getTime() ?? 0) > now
                    }
                  />
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
