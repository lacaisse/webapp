import { NextResponse, type NextRequest } from "next/server";

import { retryPendingMints } from "@/services/token-operations/retry";

// Vercel cron entry — see vercel.json. Re-submits TokenOperation rows in
// PENDING with no txHash (initial submit-to-CP failed). Complements the
// status-polling cron, which only handles ops with a txHash.

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${expected}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const stats = await retryPendingMints();
  return NextResponse.json(stats);
}
