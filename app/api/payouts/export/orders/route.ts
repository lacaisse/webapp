// SPDX-License-Identifier: AGPL-3.0-or-later
import { type NextRequest } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";

import { requireFundRole } from "@/services/auth/dal";
import { exportPayoutOrdersCsv } from "@/services/payout/operations";

// Download the transaction-level accounting export as a CSV — one row per
// order inside every payout of the chosen period, so the accountant can see
// each individual sum and its source. The sibling of `../route.ts`, which
// ships the same window as a one-row-per-payout recap; both are linked from
// the Export tab on Payments → Payouts and read the same `?from`/`?to`.
//
// A route handler rather than a server action for the same reason as the
// recap: the response IS the file, and Content-Disposition on a real
// navigation is what makes the browser save it.
//
// ADMIN-gated (payout features are ADMIN+) and fund-scoped by the host —
// requireFundRole resolves the fund from `x-fund-domain`, and the range is the
// only thing the client gets to choose. There is no fundId or payoutId input
// to spoof: the payouts are whichever ones this fund's CitizenPay treasury
// returns for the window.
export async function GET(request: NextRequest) {
  const { fund, user } = await requireFundRole("ADMIN");
  const t = await getTranslations();
  const locale = await getLocale();
  const params = request.nextUrl.searchParams;

  const result = await exportPayoutOrdersCsv(
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
