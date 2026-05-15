// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@/services/db/prisma";

// Single-use, short-lived code used to hand a verified identity from the
// centralized auth host (`auth.<APP_DOMAIN>`) to a target host. Bound to
// (userId, targetHost). 30s TTL. Single-use enforced by an atomic updateMany.
//
// This is the core of the Google-style cross-host handoff: each host owns
// its own Better Auth session cookie, and `/auth/exchange` on the target
// consumes a code to mint a fresh session there. Avoids any reliance on
// cross-subdomain cookies (which fail when third-party cookies are blocked
// and don't span paid custom domains anyway).

const TTL_MS = 30_000;
const CODE_BYTES = 32;

export async function issueExchangeCode(args: {
  userId: string;
  email: string;
  targetHost: string;
}): Promise<string> {
  const code = randomBytes(CODE_BYTES).toString("base64url");
  const now = new Date();
  await prisma.authExchange.create({
    data: {
      code,
      userId: args.userId,
      email: args.email,
      targetHost: args.targetHost,
      expiresAt: new Date(now.getTime() + TTL_MS),
    },
  });
  return code;
}

export async function consumeExchangeCode(args: {
  code: string;
  expectedHost: string;
}): Promise<{ userId: string; email: string } | null> {
  // updateMany with the where clause is atomic — concurrent calls race and
  // exactly one wins. The losers see count=0 and return null.
  const now = new Date();
  const result = await prisma.authExchange.updateMany({
    where: {
      code: args.code,
      targetHost: args.expectedHost,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (result.count === 0) return null;

  const row = await prisma.authExchange.findUnique({
    where: { code: args.code },
    select: { userId: true, email: true },
  });
  return row;
}
