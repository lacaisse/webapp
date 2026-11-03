// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { randomBytes } from "node:crypto";

import { after } from "next/server";

import { decryptSecret, encryptSecret } from "@/services/crypto/secret";
import { prisma } from "@/services/db/prisma";

import { getCitizenPayClient, type FundCredentials } from "./client";
import {
  eventsWebhookUrlFor,
  isPublishableEventsWebhookUrl,
} from "./events-webhook-url";

// Registration of the treasury events webhook with Citizen Pay (api PR P):
// `PATCH /v2/treasury { eventsWebhookUrl, eventsWebhookSecret }` with the
// receiver's url on the fund's host and the HMAC secret the api will sign
// deliveries with. The secret is minted here (32 random bytes), stored
// encrypted like the api key (`Fund.citizenPayEventsSecretEnc`) and kept
// across re-registrations so a url refresh never invalidates deliveries in
// flight; `rotate` mints a new one. The outcome lands on the fund row
// (`citizenPayEventsWebhookRegisteredAt` / `…Error`) for the settings page.
//
// Runs from the connect callback (fund setup, off the response path) and
// from Settings → Citizen Pay. Best-effort like the top-up URL sync: an api
// that predates PR P answers 400 to the unknown fields, which is recorded
// as the error and retried by hand once the api has it. Never sends a
// non-https url to the live api.

export type EventsWebhookFund = FundCredentials & {
  domain: string;
  citizenPayEventsSecretEnc: string | null;
};

export type EventsWebhookRegistration =
  | { status: "skipped"; reason: "not_connected" | "insecure_url" }
  | { status: "registered"; url: string }
  | { status: "failed"; url: string; error: string };

let warnedInsecure = false;

export async function registerTreasuryEventsWebhook(
  fund: EventsWebhookFund,
  opts: { rotate?: boolean } = {},
): Promise<EventsWebhookRegistration> {
  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
    return { status: "skipped", reason: "not_connected" };
  }
  const url = eventsWebhookUrlFor(fund);
  const live = Boolean(process.env.CITIZENPAY_API_BASE_URL);
  if (live && !isPublishableEventsWebhookUrl(url)) {
    if (!warnedInsecure) {
      console.warn(
        "[citizenpay] not registering a non-https events webhook with the live API (check NODE_ENV / APP_DOMAIN)",
        url,
      );
      warnedInsecure = true;
    }
    return { status: "skipped", reason: "insecure_url" };
  }

  const secret =
    !opts.rotate && fund.citizenPayEventsSecretEnc
      ? decryptSecret(fund.citizenPayEventsSecretEnc)
      : randomBytes(32).toString("hex");

  try {
    await getCitizenPayClient(fund).setTreasuryEventsWebhook({ url, secret });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[citizenpay] setTreasuryEventsWebhook failed", fund.id, message);
    await prisma.fund
      .update({
        where: { id: fund.id },
        data: { citizenPayEventsWebhookError: message.slice(0, 500) },
      })
      .catch((e) => console.warn("[citizenpay] events webhook error write failed", e));
    return { status: "failed", url, error: message };
  }

  await prisma.fund.update({
    where: { id: fund.id },
    data: {
      citizenPayEventsSecretEnc: encryptSecret(secret),
      citizenPayEventsWebhookRegisteredAt: new Date(),
      citizenPayEventsWebhookError: null,
    },
  });
  return { status: "registered", url };
}

/**
 * Run `registerTreasuryEventsWebhook` after the current response is sent
 * (Next's `after`), so a slow Citizen Pay never stalls the connect redirect.
 * Never throws.
 */
export function scheduleTreasuryEventsWebhookRegistration(
  fund: EventsWebhookFund,
): void {
  try {
    after(async () => {
      await registerTreasuryEventsWebhook(fund);
    });
  } catch (e) {
    console.warn("[citizenpay] could not schedule events webhook registration", fund.id, e);
  }
}
