// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";
import { advanceConversions } from "@/services/convert/progress";
import { cronGate } from "@/services/cron/guard";

// Vercel cron entry — see vercel.json. Token conversions (services/convert):
// polls the CoW orders of conversions waiting for a fill and records the
// fill (or the expiry), and repairs conversions whose Safe proposal
// executed or disappeared without the hook in proposals.ts running.

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const result = await advanceConversions();
  return NextResponse.json(result);
}
