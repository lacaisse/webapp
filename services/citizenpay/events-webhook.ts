// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { randomBytes } from "node:crypto";

import { decryptSecret, encryptSecret } from "@/services/crypto/secret";
import { prisma } from "@/services/db/prisma";

import {
  isLiveCitizenPay,
  scheduleAfterResponse,
  warnInsecureUrlOnce,
} from "./after-response";
import { getCitizenPayClient, type FundCredentials } from "./client";
import {
  eventsWebhookUrlFor,
  isPublishableEventsWebhookUrl,
} from "./events-webhook-url";

// Registration of the treasury events webhook with Citizen Pay (api PR P):
// `PATCH /v2/treasury { eventsWebhookUrl, eventsWebhookSecret }` with the
// receiver's url on the fund's host and the HMAC secret the api will sign
// deliveries with. The secret is minted here (32 random bytes) and stored
// encrypted like the api key (`Fund.citizenPayEventsSecretEnc`) BEFORE it is
// sent, so the api never signs with a secret La Caisse does not hold; a
// later registration re-sends the stored secret (a url refresh never
// invalidates deliveries in flight). The outcome lands on the fund row
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

export async function registerTreasuryEventsWebhook(
  fund: EventsWebhookFund,
): Promise<EventsWebhookRegistration> {
  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
    return { status: "skipped", reason: "not_connected" };
  }
  const url = eventsWebhookUrlFor(fund);
  if (isLiveCitizenPay() && !isPublishableEventsWebhookUrl(url)) {
    warnInsecureUrlOnce("events webhook url", url);
    return { status: "skipped", reason: "insecure_url" };
  }

  let secret: string;
  if (fund.citizenPayEventsSecretEnc) {
    secret = decryptSecret(fund.citizenPayEventsSecretEnc);
  } else {
    // Persisted first: a stored secret the api does not know yet is only a
    // failed registration (shown, retried by hand); a secret the api holds
    // and La Caisse lost would refuse every delivery until re-registration.
    secret = randomBytes(32).toString("hex");
    await prisma.fund.update({
      where: { id: fund.id },
      data: { citizenPayEventsSecretEnc: encryptSecret(secret) },
    });
  }

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
      citizenPayEventsWebhookRegisteredAt: new Date(),
      citizenPayEventsWebhookError: null,
    },
  });
  return { status: "registered", url };
}

/** `registerTreasuryEventsWebhook` after the response is sent; never throws. */
export function scheduleTreasuryEventsWebhookRegistration(
  fund: EventsWebhookFund,
): void {
  scheduleAfterResponse("events webhook registration", fund.id, () =>
    registerTreasuryEventsWebhook(fund),
  );
}
