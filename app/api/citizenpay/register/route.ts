// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { requireFundRole } from "@/services/auth/dal";
import {
  cancelPendingRegistration,
  ConnectError,
  initiateTreasuryRegistration,
  resumeTreasuryRegistration,
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
// Also refused for cross-site navigations (`forbidden`) so a link on a
// foreign page can't start a handoff.
//
// A registration started in the last 30 minutes that CP hasn't finished
// yet (`registration_pending`) is a dead end only on a plain GET. The
// button navigates the *same* tab, so Back or a closed tab lands the admin
// here with nothing to click. Two ways out, both offered by the settings
// notice:
//   GET  ?resume=1  — rebuild CP's register URL for the pending fund state
//                     (no new row) and send the admin back to CP's form.
//                     Falls back to a fresh start if nothing is pending.
//   POST            — "start over": expire the pending attempts, then run
//                     the normal start. A CP tab still open on the old form
//                     fails at the callback (`state_expired`), as intended.
// A POST can't be triggered by a link prefetch, which is why the
// cancelling path isn't a GET.
//
// ADMIN-or-higher only.

export async function GET(request: NextRequest) {
  const resume = request.nextUrl.searchParams.get("resume") === "1";
  return handle(request, resume ? "resume" : "start");
}

export async function POST(request: NextRequest) {
  return handle(request, "restart");
}

async function handle(
  request: NextRequest,
  mode: "start" | "resume" | "restart",
) {
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
  const args = {
    fundId: fund.id,
    returnHost: host,
    prefill: {
      name: fund.tokenName ?? fund.name,
      symbol: fund.tokenSymbol,
      keyName: `La Caisse — initial ${date}`,
    },
  };

  try {
    if (mode === "resume") {
      try {
        const { redirectUrl } = await resumeTreasuryRegistration(args);
        return NextResponse.redirect(redirectUrl, { status: 302 });
      } catch (e) {
        // Nothing left to resume (expired or finished since the page was
        // rendered) → a fresh start is what the admin wanted anyway.
        if (!(e instanceof ConnectError) || e.code !== "no_pending_registration") {
          throw e;
        }
      }
    }
    if (mode === "restart") await cancelPendingRegistration(fund.id);
    const { redirectUrl } = await initiateTreasuryRegistration(args);
    return NextResponse.redirect(redirectUrl, { status: 302 });
  } catch (e) {
    if (e instanceof ConnectError) {
      if (e.code === "no_base_url") return back("not_configured");
      if (e.code === "registration_pending") return back("registration_pending");
    }
    throw e;
  }
}
