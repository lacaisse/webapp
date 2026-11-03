// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { z } from "zod";

import {
  applyRemoteCardState,
  resolvePlaceName,
} from "@/services/card/pin-block";
import { sendCardPinBlockedEmails } from "@/services/card/pin-block-emails";
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
// (services/card/pin-block.ts). The payload only lends the place and
// terminal for the audit line and the emails.

export const CitizenPayEventPayloadSchema = z.looseObject({
  id: z.string().min(1).max(200),
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
 * The fund an event is for: the one whose cached treasury slug is the
 * payload's `project`. The api posts to the fund's own host, so the proxy's
 * `x-fund-id` must agree when both are known; a fund whose slug was never
 * cached is taken from the host alone. Null = unknown (404), before any
 * signature work — nothing about the payload is trusted yet, and a wrong
 * fund would only fail the signature anyway.
 */
export async function resolveEventFund(
  project: string | null,
  hostFundId: string | null,
): Promise<EventFund | null> {
  const bySlug = project
    ? await prisma.fund.findFirst({
        where: { citizenPayTreasurySlug: project },
        select: EVENT_FUND_SELECT,
      })
    : null;
  if (bySlug) {
    if (hostFundId && hostFundId !== bySlug.id) return null;
    return bySlug;
  }
  if (!hostFundId) return null;
  const byHost = await prisma.fund.findUnique({
    where: { id: hostFundId },
    select: EVENT_FUND_SELECT,
  });
  if (!byHost) return null;
  if (byHost.citizenPayTreasurySlug && project && byHost.citizenPayTreasurySlug !== project) {
    return null;
  }
  return byHost;
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

  const card = await prisma.card.findFirst({
    where: {
      fundId: fund.id,
      serialNumber: { equals: payload.serial, mode: "insensitive" },
    },
    select: {
      id: true,
      serialNumber: true,
      status: true,
      blockedReason: true,
      blockedAt: true,
      number: true,
      holderName: true,
      memberId: true,
      member: { select: { firstName: true, lastName: true, email: true } },
    },
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

  const transition = await applyRemoteCardState({
    fundId: fund.id,
    card,
    remote: { status: detail.status, pinBlockedAt: detail.pinBlockedAt },
    source: "WEBHOOK",
    context: { citizenPayEventId: payload.id, placeId, placeName, terminalId },
  });

  switch (transition.kind) {
    case "pin_block": {
      const sent = await sendCardPinBlockedEmails({
        fund,
        card,
        eventId: payload.id,
        placeName,
        blockedAt: transition.data.blockedAt,
      });
      return {
        outcome: "APPLIED",
        detail: `PIN block imported; ${sent.staff} staff email(s), holder ${sent.holder ? "emailed" : "not emailed"}`,
      };
    }
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
