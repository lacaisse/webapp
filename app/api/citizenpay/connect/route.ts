// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { requireFundRole } from "@/services/auth/dal";
import { initiateKeyIssue, ConnectError } from "@/services/citizenpay/connect";
import { getCurrentFundDomain, getFundUrl } from "@/services/fund/server";

// Mint (or rotate) the fund's CitizenPay API key against an existing
// treasury. The treasury_id is set manually in settings beforehand; this
// route 302s the admin to CP's keys-register flow, which redirects back
// to the shared callback to deliver the new key.
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

  if (!fund.citizenPayFundId) return back("not_connected");
  if (!host) return back("no_fund_host");

  // `key_name` is stored on CP-side `treasury_api_keys` and shown in the
  // CP dashboard's audit log — date-stamp so multiple issuances are
  // distinguishable. Suffix flips between "initial" and "rotated YYYY-MM-DD"
  // so an operator can tell which one cut over without a DB query.
  const date = new Date().toISOString().slice(0, 10);
  const keyName = fund.citizenPayApiKeyId
    ? `La Caisse — rotated ${date}`
    : `La Caisse — initial ${date}`;

  try {
    const { redirectUrl } = await initiateKeyIssue({
      fundId: fund.id,
      returnHost: host,
      treasuryId: fund.citizenPayFundId,
      keyName,
    });
    return NextResponse.redirect(redirectUrl, { status: 302 });
  } catch (e) {
    if (e instanceof ConnectError && e.code === "no_base_url") {
      return back("not_configured");
    }
    throw e;
  }
}
