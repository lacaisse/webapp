// SPDX-License-Identifier: AGPL-3.0-or-later
import { getLocale, getTranslations } from "next-intl/server";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { buildMemberExportCsv } from "@/services/member/export";

// Download every member of the fund as a spreadsheet-ready CSV (issue #206).
// Linked from the Export button on Members.
//
// A route handler rather than a server action because the response IS the
// file: an action would have to ship the whole CSV through the RSC payload
// and have the browser re-wrap it as a blob, and Content-Disposition is what
// makes this a real download. See app/api/payouts/export/route.ts for the
// same reasoning.
//
// OPERATOR-gated to match the /members page itself — member administration is
// an OPERATOR capability (see AGENTS.md) — and fund-scoped by the host:
// requireFundRole resolves the fund from `x-fund-domain`. There's no input to
// spoof; every member of the resolved fund is included.
export async function GET() {
  const { fund } = await requireFundRole("OPERATOR");
  const t = await getTranslations();
  const locale = await getLocale();

  const members = await prisma.member.findMany({
    where: { fundId: fund.id },
    orderBy: { createdAt: "desc" },
    select: {
      firstName: true,
      lastName: true,
      email: true,
      status: true,
      tier: { select: { name: true } },
      contributionAmount: true,
      address: true,
      postalCode: true,
      city: true,
      paymentReference: true,
      cards: { select: { serialNumber: true } },
      joinedAt: true,
      notes: true,
    },
  });

  const file = buildMemberExportCsv({
    members: members.map((m) => ({
      ...m,
      contributionAmount: m.contributionAmount?.toString() ?? null,
    })),
    fundDomain: fund.domain,
    today: new Date().toISOString().slice(0, 10),
    locale,
    t: (key: string) => t(key as never),
  });

  return new Response(file.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
