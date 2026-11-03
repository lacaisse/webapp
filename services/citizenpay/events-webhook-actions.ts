// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";

import { registerTreasuryEventsWebhook } from "./events-webhook";

// Settings → Citizen Pay → "Register the events webhook": the by-hand entry
// to services/citizenpay/events-webhook.ts, for funds connected before the
// webhook existed and for retrying a failed registration. ADMIN, like the
// rest of the settings page.

export type RegisterEventsWebhookResult =
  | { ok: true; url: string }
  | { error: string };

export async function registerCitizenPayEventsWebhookAction(): Promise<RegisterEventsWebhookResult> {
  const t = await getTranslations("fund.settings.citizenpay.events.errors");
  const { fund } = await requireFundRole("ADMIN");

  const result = await registerTreasuryEventsWebhook(fund);
  revalidatePath("/settings");
  switch (result.status) {
    case "registered":
      return { ok: true, url: result.url };
    case "skipped":
      return {
        error:
          result.reason === "not_connected" ? t("notConnected") : t("insecureUrl"),
      };
    case "failed":
      return { error: t("failed", { message: result.error }) };
  }
}
