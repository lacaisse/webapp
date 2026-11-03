// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";
import { FUND_APEX, getFundUrl } from "@/services/fund/host";

// The `fund=<slug>` hint on the wallet's authorize request (plan §6): the
// authorize query is passed through into the signed login query the provider
// sends the browser to, so the auth host's /login reads it back and brands
// itself with that fund — name, logo, colour — and links to the fund's
// member sign-up. The wallet knows funds by their Citizen Pay treasury slug
// (the `fund.slug` of the api's 403 `private` answer), which La Caisse
// caches on `Fund.citizenPayTreasurySlug`; a fund's own subdomain label or
// full domain is accepted too. Only funds with member login on are
// resolved — a hint for any other fund brands nothing.

export type MemberFundHint = {
  id: string;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  /** The fund host's member pages (rewritten by proxy.ts). */
  loginUrl: string;
  signupUrl: string;
};

const HINT_RE = /^[a-z0-9][a-z0-9.-]{0,120}$/i;

export async function resolveMemberFundHint(
  hint: string | null | undefined,
): Promise<MemberFundHint | null> {
  const value = hint?.trim().toLowerCase();
  if (!value || !HINT_RE.test(value)) return null;
  const domain = value.includes(".") ? value : `${value}.${FUND_APEX}`;
  const fund = await prisma.fund.findFirst({
    where: {
      memberLoginEnabled: true,
      OR: [{ citizenPayTreasurySlug: value }, { domain }],
    },
    select: { id: true, name: true, logoUrl: true, primaryColor: true, domain: true },
  });
  if (!fund) return null;
  const base = getFundUrl(fund.domain);
  return {
    id: fund.id,
    name: fund.name,
    logoUrl: fund.logoUrl,
    primaryColor: fund.primaryColor,
    loginUrl: `${base}/login`,
    signupUrl: `${base}/signup`,
  };
}
