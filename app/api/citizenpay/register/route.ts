// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { requireFundRole } from "@/services/auth/dal";
import {
  initiateTreasuryRegistration,
  ConnectError,
} from "@/services/citizenpay/connect";
import { getCurrentFundDomain, getFundUrl } from "@/services/fund/server";
import { isCrossSiteRequest } from "@/services/http/sec-fetch-site";

// Register this fund as a *new* treasury on CitizenPay (CP's Flow 1).
// Mirrors ../connect/route.ts, but for a fund that has no treasury yet:
// we 302 the admin to CP's /v2/treasury/register with the fund's token
// name/symbol pre-filled. CP's dashboard creates the treasury (and lets the
// admin deploy the Gnosis token in place), mints the first API key, and
// redirects back to the shared callback, which stores treasury id + key.
//
// Refused (with a flash) once `citizenPayFundId` is set — re-registering
// would create a second treasury on CP that nothing here points at. To
// (re)issue a key for the existing treasury, use /api/citizenpay/connect.
// Also refused while a registration started in the last 30 minutes is
// still open (`registration_pending`), and for cross-site navigations
// (`forbidden`) so a link on a foreign page can't start a handoff.
//
// ADMIN-or-higher only.

export async function GET(request: NextRequest) {
  const { fund } = await requireFundRole("ADMIN");

  // Same hazard as the callback: `request.url` can drop the wildcard
  // subdomain in dev. Build the back-redirect from the canonical fund
  // domain when we have one.
  const host = await getCurrentFundDomain();
  const back = (status: string) => {
    const target = host
      ? `${getFundUrl(host)}/settings?tab=citizenpay&connect=${status}`
      : new URL(`/settings?tab=citizenpay&connect=${status}`, request.url);
    return NextResponse.redirect(target, { status: 302 });
  };

  if (isCrossSiteRequest(request.headers)) return back("forbidden");
  if (fund.citizenPayFundId) return back("already_registered");
  if (!host) return back("no_fund_host");

  // `key_name` is stored on CP-side `treasury_api_keys` and shown in the
  // CP dashboard's audit log — same labelling as the connect route.
  const date = new Date().toISOString().slice(0, 10);

  try {
    const { redirectUrl } = await initiateTreasuryRegistration({
      fundId: fund.id,
      returnHost: host,
      prefill: {
        name: fund.tokenName ?? fund.name,
        symbol: fund.tokenSymbol,
        keyName: `La Caisse — initial ${date}`,
      },
    });
    return NextResponse.redirect(redirectUrl, { status: 302 });
  } catch (e) {
    if (e instanceof ConnectError) {
      if (e.code === "no_base_url") return back("not_configured");
      if (e.code === "registration_pending") return back("registration_pending");
    }
    throw e;
  }
}
