// SPDX-License-Identifier: AGPL-3.0-or-later

// Allocation / email eligibility by member status (issue #17). ACTIVE is the
// only status that receives allocations (mints) and the allocation email
// automation; NEW / INACTIVE / PAUSED / STOPPED / REJECTED all suppress both
// but carry distinct operator meaning. This is the single source of truth for
// that gate — used by the bank-sync mint path and (implicitly via the
// status: "ACTIVE" filter) by period close.

import type { MemberStatus } from "@/services/db/generated/enums";

export const ALLOCATION_ELIGIBLE_STATUS: MemberStatus = "ACTIVE";

export function isAllocationEligible(status: MemberStatus): boolean {
  return status === ALLOCATION_ELIGIBLE_STATUS;
}
