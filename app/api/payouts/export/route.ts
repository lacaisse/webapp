// SPDX-License-Identifier: AGPL-3.0-or-later
import { type NextRequest } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";

import { requireFundRole } from "@/services/auth/dal";
import { exportPayoutsCsv } from "@/services/payout/operations";

// Download the merchant-payout accounting export as a CSV — the per-third-party
// recap ("date, montant, commerçant concerné") a fund's accountant asks for.
// Linked from the Export tab on Payments → Payouts, which puts the range in
// `?from`/`?to` so the URL is shareable and the link is a plain <a>.
//
// A route handler rather than a server action because the response IS the file:
// an action would have to ship the whole CSV through the RSC payload and have
// the browser re-wrap it as a blob, and Content-Disposition is what makes this
// a real download.
//
// ADMIN-gated (payout features are ADMIN+) and fund-scoped by the host —
// requireFundRole resolves the fund from `x-fund-domain`, and the range is the
// only thing the client gets to choose. There is no fundId input to spoof.
export async function GET(request: NextRequest) {
  const { fund, user } = await requireFundRole("ADMIN");
  const t = await getTranslations();
  const locale = await getLocale();
  const params = request.nextUrl.searchParams;

  const result = await exportPayoutsCsv(
    { fund, userId: user.id, t: (key: string) => t(key as never) },
    {
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
      locale,
    },
  );

  if ("error" in result) {
    return new Response(result.error, {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(result.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
