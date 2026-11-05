// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { headers } from "next/headers";

// The caller's address as the platform forwards it (Vercel sets
// x-forwarded-for; the first hop is the client), keying the per-IP attempt
// limiters on public server actions and pages (services/auth/attempt-
// limiter.ts). "unknown" when nothing is forwarded (a plain local request):
// every such caller then shares one bucket, which only makes a limit stricter.
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}
