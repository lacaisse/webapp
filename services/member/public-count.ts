// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { MemberStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";

// Statuses that count as a "participant" for the public counter (issue #198):
// the org's homepage number is the members?tab=active plus members?tab=paused
// populations, per the issue thread. NEW applications and members who left
// (INACTIVE / STOPPED / REJECTED) are not participants.
const PUBLIC_MEMBER_COUNT_STATUSES = [
  MemberStatus.ACTIVE,
  MemberStatus.PAUSED,
];

/**
 * Number of active + paused members of one fund, for the public
 * active-members-count endpoint. A bare count is the entire public surface —
 * nothing about who the members are leaves the server.
 */
export async function countPublicActiveMembers(
  fundId: string,
): Promise<number> {
  return prisma.member.count({
    where: { fundId, status: { in: PUBLIC_MEMBER_COUNT_STATUSES } },
  });
}
