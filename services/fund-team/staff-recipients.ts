// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";

// The fund's OWNER/ADMIN staff emails, deduplicated: who gets the fund-level
// notifications (a card another fund asks to enroll, a card Citizen Pay
// PIN-blocked). One query for every sender.
export async function staffRecipients(fundId: string): Promise<string[]> {
  const staff = await prisma.fundMember.findMany({
    where: { fundId, role: { in: ["OWNER", "ADMIN"] } },
    select: { user: { select: { email: true } } },
  });
  return [...new Set(staff.map((s) => s.user.email).filter(Boolean))];
}
