// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared (client + server) member-status config. Kept out of the "use server"
// action file so the status-change dialog can import the transition map and
// status list ("use server" modules may only export async functions).

import type { MemberStatus } from "@/services/db/generated/enums";

// All member statuses, in display order. ACTIVE is the only status that
// receives allocations + the allocation email automation (issue #17); the
// rest suppress both but carry distinct operator meaning.
export const MEMBER_STATUSES = [
  "NEW",
  "ACTIVE",
  "INACTIVE",
  "PAUSED",
  "STOPPED",
  "REJECTED",
] as const satisfies readonly MemberStatus[];

// Admin-driven status transitions. NEW → ACTIVE is intentionally absent:
// activation is owned by the card-linking flow (activateMemberAction), which
// requires a card before a member goes active. Entering STOPPED stamps a leave
// date (see status-actions.ts).
export const MEMBER_STATUS_TRANSITIONS: Record<
  MemberStatus,
  readonly MemberStatus[]
> = {
  NEW: ["REJECTED"],
  ACTIVE: ["INACTIVE", "PAUSED", "STOPPED"],
  INACTIVE: ["ACTIVE", "PAUSED", "STOPPED"],
  PAUSED: ["ACTIVE", "INACTIVE", "STOPPED"],
  STOPPED: ["ACTIVE"],
  REJECTED: ["NEW"],
};
