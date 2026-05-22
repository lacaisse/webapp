// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/services/db/prisma";

// Vercel cron entry — see vercel.json. Sweeps expired short-lived rows so
// their tables don't grow unbounded. Each row already becomes unusable
// once `expiresAt` passes (consume paths check `expiresAt > now`); the
// sweep just reclaims storage. We keep a 1-day grace period in case we
// ever want to audit recent expirations.
//
// Covered tables:
//   - AuthExchange (cross-host login handoff)
//   - CitizenPayConnectAttempt (CP treasury-connect handoff)
//
// Vercel injects `Authorization: Bearer ${CRON_SECRET}` on cron-triggered
// requests. We reject anything else so the endpoint isn't a free
// "delete things" button on the public internet.

const GRACE_MS = 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${expected}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const cutoff = new Date(Date.now() - GRACE_MS);
  const [authExchange, citizenPayConnect] = await Promise.all([
    prisma.authExchange.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.citizenPayConnectAttempt.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    }),
  ]);
  return NextResponse.json({
    authExchange: authExchange.count,
    citizenPayConnect: citizenPayConnect.count,
  });
}
