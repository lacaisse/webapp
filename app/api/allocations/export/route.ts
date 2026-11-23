// SPDX-License-Identifier: AGPL-3.0-or-later
import { type NextRequest } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";

import { buildAllocationExportCsv } from "@/services/allocation-periods/export";
import { loadAllocationExportData } from "@/services/allocation-periods/export-data";
import { requireFundRole } from "@/services/auth/dal";

// Download what each member paid in and received per allocation period as a
// spreadsheet-ready CSV (issue #320). Linked from the schedule on Allocations
// (every period, plus per-member totals) and from a period's page
// (`?period=<id>`, that period only).
//
// A route handler rather than a server action because the response IS the
// file — see app/api/members/export/route.ts for the reasoning.
//
// ADMIN-gated like the Allocations pages, and fund-scoped by the host:
// requireFundRole resolves the fund from `x-fund-domain`. The period id is
// the only input, and it is looked up inside that fund — another fund's
// period is a 404.
export async function GET(request: NextRequest) {
  const { fund } = await requireFundRole("ADMIN");
  const t = await getTranslations();
  const locale = await getLocale();
  const periodId = request.nextUrl.searchParams.get("period") || null;

  const data = await loadAllocationExportData({ fundId: fund.id, periodId });
  if (!data) return new Response(null, { status: 404 });

  const file = buildAllocationExportCsv({
    ...data,
    scope: periodId ? "period" : "all",
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
