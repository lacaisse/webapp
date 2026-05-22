// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { consumeConnect, ConnectError } from "@/services/citizenpay/connect";
import { getCurrentFundDomain, getFundUrl } from "@/services/fund/server";

// Return URL for the CitizenPay treasury-connect handoff. CP redirects
// here after the user finishes either flow on the dashboard:
//   /api/citizenpay/callback/<fundState>?state=<cpState>&pickup=<token>&treasury_id=<uuid>
//
// `fundState` is in the path (not query) because CP appends `?state=…`
// unconditionally and we want to avoid a `??` collision. The fund state
// is what proves the callback was triggered by a flow this server
// initiated — CP's `state` is opaque to us (CP generates it).
//
// Public endpoint by necessity (the user is mid-redirect from CP and any
// session bridge may not have survived the round trip), but the fund
// state row + pickup token together are what authorise the write —
// hitting this without a valid fund state can't do anything.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fundState: string }> },
) {
  const { fundState } = await params;
  const url = new URL(request.url);
  const cpState = url.searchParams.get("state");
  const pickupToken = url.searchParams.get("pickup");

  // Build the back-redirect off the canonical fund domain (set by proxy.ts
  // on x-fund-domain) rather than `request.url`. `request.url` in route
  // handlers can drop the wildcard subdomain in dev, which would land the
  // user on the apex — and the (fund) layout would then bounce them to
  // apex `/` because the host-type isn't `fund` over there.
  const host = await getCurrentFundDomain();
  const back = (status: string) => {
    const target = host
      ? `${getFundUrl(host)}/settings?tab=citizenpay&connect=${status}`
      : new URL(`/settings?tab=citizenpay&connect=${status}`, request.url);
    return NextResponse.redirect(target, { status: 302 });
  };

  if (!cpState || !pickupToken) return back("missing_params");
  if (!host) return back("no_fund_host");

  try {
    await consumeConnect({ fundState, cpState, pickupToken, callbackHost: host });
    return back("ok");
  } catch (e) {
    if (e instanceof ConnectError) {
      console.warn("[citizenpay-connect] callback rejected", e.code, e.message);
      return back(e.code);
    }
    console.error("[citizenpay-connect] callback error", e);
    return back("error");
  }
}
