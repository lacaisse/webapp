// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import {
  getCurrentFund,
  getCurrentFundDomain,
  getFundUrl,
} from "@/services/fund/server";

// CitizenPay redirects the merchant's browser here after they accept or
// reject a treasury invite. The URL CP builds:
//   {redirect_uri}?token=…&status=accepted|rejected&treasury_id=…&business_id=…
//
// Per docs/TREASURY_DASHBOARD_CONNECTIONS.md the query-string params are
// a hint, not proof — we re-verify via the public lookup endpoint before
// writing anything locally.
//
// Public by necessity (the merchant is mid-redirect from CP and may not
// have a session in this app at all). The CP-issued token is the secret;
// possession + a match against a row we minted is what authorises the
// write.

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const queryStatus = url.searchParams.get("status");

  const host = await getCurrentFundDomain();
  // The merchant has no account in the treasury dashboard — we land them
  // on a public confirmation page that just acknowledges the outcome.
  // The treasury admin sees the result by reloading /merchants (the DB
  // writes below already happened server-side, so no further sync is
  // needed from their side).
  const back = (status: string) => {
    const path = `/citizenpay/invite-confirmed?status=${status}`;
    const target = host
      ? `${getFundUrl(host)}${path}`
      : new URL(path, request.url);
    return NextResponse.redirect(target, { status: 302 });
  };

  if (!token) return back("missing_params");
  if (!host) return back("no_fund_host");

  const fund = await getCurrentFund();
  if (!fund) return back("no_fund");

  // Match the token to an in-flight invite on this fund. The unique
  // index on (fundId, citizenPayInviteToken) makes this O(1) and also
  // means a stray callback from another fund's treasury can't land on
  // someone else's merchant.
  const merchant = await prisma.merchant.findFirst({
    where: { fundId: fund.id, citizenPayInviteToken: token },
    select: { id: true, citizenPayInviteEmail: true },
  });
  if (!merchant) return back("invite_unknown");

  // Server-side verify with CP before trusting the query params. CP's
  // own `accepted_business_id` is the source of truth — even if a
  // malicious actor crafted a callback with their own business_id, the
  // verify call would return CP's actual value (or 404).
  let invite;
  try {
    invite = await getCitizenPayClient(fund).getMerchantInvite(token);
  } catch (e) {
    console.error("[invite-callback] verify failed", e);
    return back("verify_failed");
  }
  if (!invite) return back("invite_unknown");

  if (invite.status === "rejected" || invite.status === "expired") {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: {
        citizenPayInviteToken: null,
        citizenPayInviteEmail: null,
        citizenPayInviteSentAt: null,
        citizenPayInviteExpiresAt: null,
      },
    });
    return back(invite.status);
  }

  if (invite.status !== "accepted" || !invite.acceptedBusinessId) {
    // Pending — shouldn't normally hit this branch unless CP fires the
    // redirect before flipping its own row. Tell the user to refresh.
    console.warn(
      "[invite-callback] status is",
      invite.status,
      "for token",
      token,
      "queryStatus=",
      queryStatus,
    );
    return back("pending");
  }

  // Accept path. Write businessId and try to claim a place under that
  // business in the same transaction-ish flow. Claiming a place is best-
  // effort — if it fails or there are no places yet, the admin can run
  // the Sync dialog to backfill.
  const businessId = invite.acceptedBusinessId;
  try {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: {
        citizenPayBusinessId: businessId,
        citizenPayActivatedAt: new Date(),
        citizenPayInviteToken: null,
        citizenPayInviteEmail: null,
        citizenPayInviteSentAt: null,
        citizenPayInviteExpiresAt: null,
      },
    });
  } catch (e) {
    console.error("[invite-callback] merchant update failed", merchant.id, e);
    return back("write_failed");
  }

  // Best-effort: claim the first unclaimed place under this business
  // for the invited merchant. Saves the admin a Sync round-trip in the
  // common 1-place-per-business case. Multi-place businesses still need
  // a Sync run for siblings, which is documented in the UI banner.
  try {
    const { places } = await getCitizenPayClient(fund).listPlaces();
    const claimable = places.find(
      (p) => p.businessId === businessId && p.account !== null,
    );
    if (claimable) {
      const alreadyClaimed = await prisma.merchant.findFirst({
        where: { fundId: fund.id, citizenPayPlaceId: claimable.id },
        select: { id: true },
      });
      if (!alreadyClaimed) {
        await prisma.merchant.update({
          where: { id: merchant.id },
          data: {
            citizenPayPlaceId: claimable.id,
            citizenPayPlaceAccount: claimable.account,
            citizenPayLastSyncedAt: new Date(),
            ...(claimable.address ? { address: claimable.address } : {}),
            ...(claimable.city ? { city: claimable.city } : {}),
            ...(claimable.country ? { country: claimable.country } : {}),
            ...(claimable.postalCode
              ? { postalCode: claimable.postalCode }
              : {}),
            ...(claimable.latitude !== null
              ? { latitude: claimable.latitude }
              : {}),
            ...(claimable.longitude !== null
              ? { longitude: claimable.longitude }
              : {}),
          },
        });
      }
    }
  } catch (e) {
    // Don't fail the whole flow — the merchant is connected at the
    // business level. The Sync dialog will pick up the place next run.
    console.warn("[invite-callback] place claim failed", merchant.id, e);
  }

  return back("ok");
}
