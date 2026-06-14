// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Error messages are translation KEYS — the form calls t() at display time,
// the action calls getTranslations() server-side before returning.

export const WAITLIST_FUND_NAME_MAX = 80;

export const WaitlistSchema = z.object({
  email: z.email({ error: "auth.errors.emailInvalid" }),
  // Optional note: what they'd call their fund / why they're interested.
  fundName: z
    .string()
    .max(WAITLIST_FUND_NAME_MAX, {
      error: "landing.waitlist.errors.fundNameMax",
    })
    .optional(),
});
export type WaitlistInput = z.infer<typeof WaitlistSchema>;
