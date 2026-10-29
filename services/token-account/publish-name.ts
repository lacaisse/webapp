// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { after } from "next/server";

import {
  credsOf,
  failureCode,
  isConnected,
  type PublishHolderNameFund,
  type PublishOutcome,
} from "@/services/card/publish-holder-name";
import { getCitizenPayClient } from "@/services/citizenpay/client";

// Publish a SOURCE token account's name to CitizenPay. On CP a SOURCE account
// is just a card (serial `ACCT-…`, see ./serial.ts), and CP keeps a display
// name per card account. The public card wallet (tap.citizenpay.eu) uses it:
// a capped card's wallet says "Covered by <source name> this week" and tags
// the fund's pulls with it. Without a published name it falls back to the
// fund's name.
//
// Same contract as the card holder-name publish (services/card/
// publish-holder-name.ts): best-effort and OFF the request path. Actions call
// `scheduleAccountNamePublish`, which defers the PUT with `after()` so the
// user's response never waits on CP. Our DB is the record; CP is the display
// layer. A failure is logged as a status code with a fixed message (never the
// name, the serial, or CP's error text) and swallowed.
// `scripts/sync-account-names.ts` re-publishes in bulk.

export type PublishAccountNameFund = PublishHolderNameFund;

export type PublishAccountNameInput = { serial: string; name: string };

/** Publish one account's name now (awaited). Logs once on failure; never throws. */
export async function publishAccountName(
  fund: PublishAccountNameFund,
  account: PublishAccountNameInput,
): Promise<PublishOutcome> {
  if (!isConnected(fund)) return "skipped";
  try {
    await getCitizenPayClient(fund).setCardHolderName(
      account.serial,
      account.name.trim() || null,
    );
    return "ok";
  } catch (e) {
    const code = failureCode(e);
    console.warn(
      `[citizenpay] account-name publish failed (best-effort): ${code}`,
    );
    return code;
  }
}

/**
 * Publish the account's name after the response is sent (`after()`), so a
 * slow or missing CP endpoint never delays the user's action. Call from
 * server actions.
 */
export function scheduleAccountNamePublish(
  fund: PublishAccountNameFund,
  account: PublishAccountNameInput,
): void {
  if (!isConnected(fund)) return;
  const f = credsOf(fund);
  const a = { serial: account.serial, name: account.name };
  after(async () => {
    await publishAccountName(f, a);
  });
}
