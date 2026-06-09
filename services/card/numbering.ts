// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";

// Next per-fund card number = current max + 1 (numbers start at 1). These are
// the numbers members encode in their Belgian structured communication, so
// they must be unique within a fund — enforced by @@unique([fundId, number]).
//
// Low concurrency (admin-driven card creation); a rare race just hits the
// unique constraint and the caller surfaces/retries. Callers can pass a
// transaction client to allocate within the same tx as the create.
export async function nextCardNumber(fundId: string): Promise<number> {
  const top = await prisma.card.findFirst({
    where: { fundId, number: { not: null } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return (top?.number ?? 0) + 1;
}
