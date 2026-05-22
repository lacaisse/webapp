// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireCurrentFund } from "@/services/fund/server";

// Landing page the merchant's browser hits after the CitizenPay invite
// callback runs. The callback (server-side, treasury API-key auth) does
// all the DB writing — this page is purely cosmetic: tell the merchant
// the connection is recorded and they can close the tab. They have no
// account in the treasury dashboard, so we deliberately don't link them
// anywhere else.
//
// Lives under (fund-public) — no auth — and is scoped to the fund host
// so we can show the fund's name and branding.

type Status = "ok" | "rejected" | "expired" | "pending" | "error";

const KNOWN: Status[] = ["ok", "rejected", "expired", "pending", "error"];

// `reason` is the raw `connect=…` value the callback appended. We map a
// handful of CP-side states to friendly status keys; anything else gets
// the generic error message rather than leaking the internal code.
function statusFor(raw: string | undefined): Status {
  if (raw === "ok") return "ok";
  if (raw === "rejected") return "rejected";
  if (raw === "expired") return "expired";
  if (raw === "pending") return "pending";
  if (raw && KNOWN.includes(raw as Status)) return raw as Status;
  return "error";
}

export default async function InviteConfirmedPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const fund = await requireCurrentFund();
  const { status: rawStatus } = await searchParams;
  const status = statusFor(rawStatus);
  const t = await getTranslations("merchants.inviteConfirmed");

  return (
    <div className="w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t(`${status}.title`)}</CardTitle>
          <CardDescription>
            {t(`${status}.description`, { fundName: fund.name })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t(`${status}.nextSteps`)}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
