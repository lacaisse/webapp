// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { z } from "zod";

import {
  applyRemoteCardState,
  RECONCILABLE_CARD_SELECT,
  resolvePlaceName,
} from "@/services/card/pin-block";
import { prisma } from "@/services/db/prisma";

import { getCitizenPayClient } from "./client";

// The Citizen Pay treasury events webhook (api PR P): the api posts
// `{id, type:"card.blocked", project, serial, at, place_id, terminal_id,
// pin_block_count}` (and `card.unblocked {by}`) to the url the fund
// registered, signed with the fund's secret (events-signature.ts). The
// receiver is app/api/citizenpay/events; this module resolves the fund and
// handles one verified, not-yet-seen event.
//
// The payload is a notification, never a fact: deliveries retry and can
// arrive out of order, so on any `card.*` event the card is re-read from the
// api (`GET /v2/treasury/cards/{serial}`) and that read is applied
// (services/card/pin-block.ts, which also sends the notifications for a
// block it imports). The payload only lends the place and terminal for the
// audit line and the emails.

export const CitizenPayEventPayloadSchema = z.looseObject({
  // The api serialises its event id as a JSON number (api#251
  // `CardEvent.ID int64`); a string is accepted too. Kept as a string here.
  id: z.union([z.string().min(1).max(200), z.number().int()]).transform(String),
  type: z.string().min(1).max(100),
  project: z.string().min(1).max(200).nullish(),
  serial: z.string().min(1).max(100).nullish(),
  at: z.string().max(100).nullish(),
  place_id: z.union([z.string(), z.number()]).nullish(),
  terminal_id: z.union([z.string(), z.number()]).nullish(),
  pin_block_count: z.number().int().nullish(),
  by: z.string().max(100).nullish(),
});

export type CitizenPayEventPayload = z.infer<typeof CitizenPayEventPayloadSchema>;

export const EVENT_FUND_SELECT = {
  id: true,
  name: true,
  domain: true,
  timezone: true,
  primaryColor: true,
  logoUrl: true,
  senderEmail: true,
  citizenPayApiKeyId: true,
  citizenPayApiKeyEnc: true,
  citizenPayEventsSecretEnc: true,
  citizenPayTreasurySlug: true,
} as const;

export type EventFund = {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  primaryColor: string | null;
  logoUrl: string | null;
  senderEmail: string | null;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
  citizenPayEventsSecretEnc: string | null;
  citizenPayTreasurySlug: string | null;
};

/**
 * The fund an event is for: the host's. The api posts to the url the fund
 * registered, on the fund's own host, so the proxy's `x-fund-id` (which it
 * strips from every inbound request before setting it) names the fund; the
 * payload's `project` (treasury slug) is only cross-checked against the
 * cached slug when both are known. Nothing is looked up from the payload,
 * so a caller cannot probe which treasuries are La Caisse funds. Null =
 * unknown, answered before any signature work with the same generic 401 as
 * everything else that precedes the check.
 */
export async function resolveEventFund(
  hostFundId: string | null,
  project: string | null,
): Promise<EventFund | null> {
  if (!hostFundId) return null;
  const fund = await prisma.fund.findUnique({
    where: { id: hostFundId },
    select: EVENT_FUND_SELECT,
  });
  if (!fund) return null;
  if (fund.citizenPayTreasurySlug && project && fund.citizenPayTreasurySlug !== project) {
    return null;
  }
  return fund;
}

export type CitizenPayEventOutcome = {
  outcome: "APPLIED" | "IGNORED" | "FAILED";
  detail: string;
};

/**
 * Handle one verified event the fund has not seen before. Throws when the
 * api cannot be read or the local write fails — the route records FAILED
 * and answers 500 so the api redelivers.
 */
export async function handleCitizenPayEvent(
  fund: EventFund,
  payload: CitizenPayEventPayload,
): Promise<CitizenPayEventOutcome> {
  if (!payload.type.startsWith("card.")) {
    return { outcome: "IGNORED", detail: `unhandled type ${payload.type}` };
  }
  if (!payload.serial) {
    return { outcome: "IGNORED", detail: "no serial on the event" };
  }
  // A fund that disconnected from Citizen Pay but still has the webhook
  // registered cannot re-read anything: ignored, not failed (a FAILED
  // answer would only make the api retry).
  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
    return { outcome: "IGNORED", detail: "fund not connected to Citizen Pay" };
  }

  const card = await prisma.card.findFirst({
    where: {
      fundId: fund.id,
      serialNumber: { equals: payload.serial, mode: "insensitive" },
    },
    select: RECONCILABLE_CARD_SELECT,
  });
  if (!card) {
    return { outcome: "IGNORED", detail: "card not on file for this fund" };
  }

  // The re-read is the fact; the payload said nothing we act on.
  const detail = await getCitizenPayClient(fund).getCitizenPayCard(card.serialNumber);
  if (!detail) {
    return { outcome: "IGNORED", detail: "card unknown at Citizen Pay" };
  }

  const blockedEvent = detail.pinEvents.find((e) => e.action === "blocked");
  const placeId = str(payload.place_id) ?? blockedEvent?.placeId ?? null;
  const terminalId = str(payload.terminal_id) ?? blockedEvent?.terminalId ?? null;
  const placeName = await resolvePlaceName(fund.id, placeId);

  const { transition, notified } = await applyRemoteCardState({
    fund,
    card,
    remote: { status: detail.status, pinBlockedAt: detail.pinBlockedAt },
    source: "WEBHOOK",
    context: { citizenPayEventId: payload.id, placeId, placeName, terminalId },
  });

  switch (transition.kind) {
    case "pin_block":
      return {
        outcome: "APPLIED",
        detail: `PIN block imported; ${notified?.staff ?? 0} staff email(s), holder ${notified?.holder ? "emailed" : "not emailed"}`,
      };
    case "pin_release":
      return {
        outcome: "APPLIED",
        detail: `PIN block lifted; card now ${transition.data.status}`,
      };
    case "push":
      return {
        outcome: "IGNORED",
        detail: "local status is the fund's (fund block); the card sync pushes it",
      };
    case "none":
      return { outcome: "IGNORED", detail: "already in sync" };
  }
}

function str(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
