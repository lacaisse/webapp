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

// A member is safe to hard-delete (issues #109/#35) only when there's no
// linked card and no transaction history — otherwise the delete would sever
// real audit trail (cards become orphaned, bank transactions/mints lose their
// member link). Checked both for the row-action gate and, authoritatively,
// server-side before the actual delete.
export function isMemberDeletable(counts: {
  cards: number;
  bankTransactions: number;
  tokenOperations: number;
}): boolean {
  return (
    counts.cards === 0 &&
    counts.bankTransactions === 0 &&
    counts.tokenOperations === 0
  );
}

// Members who receive the monthly payment-request reminder (issue #39). Same
// status gate as allocations: only ACTIVE members are expected to contribute;
// NEW / INACTIVE / PAUSED / STOPPED / REJECTED are all excluded (the issue
// calls out PAUSED/STOPPED explicitly — the rest never reach a contributing
// state). The other exclusions the issue lists (no card assigned, opted out of
// reminders, already paid this period) are runtime conditions, not status, so
// they're applied as query filters by the reminder cron — not encoded here.
export const REMINDER_ELIGIBLE_STATUS: MemberStatus = "ACTIVE";
