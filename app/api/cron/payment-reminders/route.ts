// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { cronGate } from "@/services/cron/guard";
import { sendMonthlyPaymentReminders } from "@/services/member/reminders";

// Vercel cron entry — see vercel.json. Runs on the 1st of each month and emails
// the monthly payment request (PAYMENT_REMINDER_FIRST) to every FIXED_PERIOD
// fund's members who are expected to contribute this period but haven't yet.
// Excludes members with no card, no tier, paused/stopped, opted out of
// reminders, or who already paid for the current period. See
// services/member/reminders.ts.

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const funds = await sendMonthlyPaymentReminders();
  const totals = funds.reduce(
    (acc, f) => ({
      sent: acc.sent + f.sent,
      alreadySent: acc.alreadySent + f.alreadySent,
      failed: acc.failed + f.failed,
    }),
    { sent: 0, alreadySent: 0, failed: 0 },
  );
  return NextResponse.json({ funds, totals });
}
