// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { prisma } from "@/services/db/prisma";

// Idempotent on email: a repeat submit refreshes the lead instead of erroring
// on the unique constraint. We never downgrade an existing status here.
export async function upsertWaitlistEntry(input: {
  email: string;
  fundName?: string | null;
  locale?: string | null;
}) {
  return prisma.waitlistEntry.upsert({
    where: { email: input.email },
    create: {
      email: input.email,
      fundName: input.fundName ?? null,
      locale: input.locale ?? null,
    },
    update: {
      // Only overwrite when the new submit actually carried a value — don't
      // clobber a previously captured fund name / locale with empties.
      ...(input.fundName ? { fundName: input.fundName } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    },
  });
}
