// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import {
  EVENTS_SIGNATURE_HEADER,
  EVENTS_TIMESTAMP_HEADER,
  verifyEventsSignature,
} from "@/services/citizenpay/events-signature";
import {
  CitizenPayEventPayloadSchema,
  handleCitizenPayEvent,
  resolveEventFund,
  type CitizenPayEventOutcome,
} from "@/services/citizenpay/events";
import { decryptSecret } from "@/services/crypto/secret";
import { prisma } from "@/services/db/prisma";

// Receiver of the Citizen Pay treasury events webhook (api PR P). Public by
// nature — the api calls it server to server — and guarded by the fund's
// registered secret: `X-CitizenPay-Signature = HMAC-SHA256(secret,
// X-CitizenPay-Timestamp + "." + body)`, constant-time compared, timestamp
// within five minutes (services/citizenpay/events-signature.ts). The fund is
// the host's (the proxy's `x-fund-id`); the payload's `project` is only
// cross-checked. Everything that goes wrong before the signature is checked
// — no fund host, unknown fund, another fund's treasury, no secret — is one
// generic 401, so nothing can be learned about which funds exist.
//
// Idempotent on the event id: every delivery is written to CitizenPayEvent
// first (unique per fund), so a redelivery is answered from that row without
// being applied twice — unless the first attempt FAILED, which the api
// retries for exactly that reason. The payload is never applied: for any
// `card.*` event the card is re-read from the api and that read decides, and a
// `topup.*` event settles the order as listed by the api
// (services/citizenpay/events.ts). 200 once handled (applied or ignored), 500
// when the re-read or the write failed so the api delivers again.

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = CitizenPayEventPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }
  const payload = parsed.data;

  const fund = await resolveEventFund(
    request.headers.get("x-fund-id"),
    payload.project ?? null,
  );
  if (!fund?.citizenPayEventsSecretEnc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const check = verifyEventsSignature({
    secret: decryptSecret(fund.citizenPayEventsSecretEnc),
    timestamp: request.headers.get(EVENTS_TIMESTAMP_HEADER),
    signature: request.headers.get(EVENTS_SIGNATURE_HEADER),
    rawBody,
  });
  if (check !== "ok") {
    return NextResponse.json({ error: check }, { status: 401 });
  }

  const occurredAt =
    payload.at && !Number.isNaN(Date.parse(payload.at))
      ? new Date(payload.at)
      : null;

  // Claim the event id. The row is the idempotency key and the settings
  // page's "last delivery" in one.
  let row: { id: string; outcome: string };
  let duplicate = false;
  try {
    row = await prisma.citizenPayEvent.create({
      data: {
        fundId: fund.id,
        eventId: payload.id,
        type: payload.type,
        // An account top-up event carries serial "" (no card).
        serial: payload.serial || null,
        occurredAt,
      },
      select: { id: true, outcome: true },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    const seen = await prisma.citizenPayEvent.findUnique({
      where: { fundId_eventId: { fundId: fund.id, eventId: payload.id } },
      select: { id: true, outcome: true },
    });
    if (!seen) throw e;
    if (seen.outcome !== "FAILED") {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        outcome: seen.outcome,
      });
    }
    row = seen;
    duplicate = true;
  }

  let result: CitizenPayEventOutcome;
  try {
    result = await handleCitizenPayEvent(fund, payload);
  } catch (e) {
    console.error("[citizenpay-events] handling failed", fund.id, payload.id, e);
    result = {
      outcome: "FAILED",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    await prisma.citizenPayEvent.update({
      where: { id: row.id },
      data: { outcome: result.outcome, detail: result.detail.slice(0, 500) },
    });
  } catch (e) {
    console.error("[citizenpay-events] outcome write failed", row.id, e);
  }

  if (result.outcome === "FAILED") {
    return NextResponse.json(
      { ok: false, outcome: result.outcome, error: result.detail },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, duplicate, outcome: result.outcome });
}
