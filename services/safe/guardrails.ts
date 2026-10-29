// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";

import { blockingSafes, type SafeSignerShape } from "./guardrails-rule";

// Review S8: demoting or removing a team member who is a MEMBER owner of a
// Safe takes their signer out of reach (sign requires ADMIN+). If the
// remaining reachable signers — other ADMIN+ members' signers plus external
// owners — can't reach the threshold, the Safe would be stuck. The team
// actions refuse in that case and name the Safes.

export async function safesBlockedByLosingMember(
  fundId: string,
  userId: string,
): Promise<{ id: string; name: string }[]> {
  const signer = await prisma.fundSigner.findUnique({
    where: { fundId_userId: { fundId, userId } },
    select: { id: true },
  });
  if (!signer) return [];
  const safes = await prisma.fundSafe.findMany({
    where: {
      fundId,
      archivedAt: null,
      status: "ACTIVE",
      owners: { some: { signerId: signer.id, removedAt: null } },
    },
    select: {
      id: true,
      name: true,
      threshold: true,
      owners: {
        where: { removedAt: null },
        select: { kind: true, signer: { select: { userId: true } } },
      },
    },
  });
  if (safes.length === 0) return [];
  const admins = await prisma.fundMember.findMany({
    where: { fundId, role: { in: ["ADMIN", "OWNER"] } },
    select: { userId: true },
  });
  const shaped: SafeSignerShape[] = safes.map((s) => ({
    id: s.id,
    name: s.name,
    threshold: s.threshold,
    owners: s.owners.map((o) => ({ kind: o.kind, userId: o.signer?.userId ?? null })),
  }));
  return blockingSafes(shaped, userId, new Set(admins.map((m) => m.userId)));
}
