// SPDX-License-Identifier: AGPL-3.0-or-later
import { FundRole } from "@/services/db/generated/enums";

// Single source of truth for the per-fund role hierarchy. Lives in a plain
// module (no "server-only") so both the server DAL (requireFundRole) and
// client components (the fund sidebar) can share one rank map.
//
// OPERATOR sits between ADMIN and VIEWER: it can manage cards and members but
// nothing else. Because guards are rank-based, anything still gated at ADMIN
// automatically excludes OPERATOR — only the card/member surface is lowered to
// requireFundRole("OPERATOR").
export const FUND_ROLE_RANK: Record<FundRole, number> = {
  VIEWER: 0,
  OPERATOR: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function hasMinFundRole(actual: FundRole, minimum: FundRole) {
  return FUND_ROLE_RANK[actual] >= FUND_ROLE_RANK[minimum];
}

// Convenience: full admin of a fund (ADMIN or OWNER). OPERATOR/VIEWER are not.
export function isFundAdmin(role: FundRole) {
  return hasMinFundRole(role, "ADMIN");
}
