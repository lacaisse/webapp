// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { signEventsPayload } from "@/services/citizenpay/events-signature";

// The events webhook end to end on a stubbed Prisma and a stubbed Citizen
// Pay client: signature and skew refusals, idempotency on the event id, and
// the rule that the card is re-read and the read applied — never the payload.
vi.mock("server-only", () => ({}));
vi.mock("@/services/crypto/secret", () => ({
  decryptSecret: (s: string) => s.replace(/^enc:/, ""),
}));

const prisma = vi.hoisted(() => ({
  fund: { findUnique: vi.fn() },
  citizenPayEvent: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  card: { findFirst: vi.fn(), update: vi.fn() },
  cardEvent: { create: vi.fn() },
  merchant: { findFirst: vi.fn() },
  // The holder events (services/card/holder-claims.ts).
  member: { findFirst: vi.fn(), updateMany: vi.fn() },
  cardHolderClaim: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const cp = vi.hoisted(() => ({ getCitizenPayCard: vi.fn(), getCardHolder: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const emails = vi.hoisted(() => ({ sendCardPinBlockedEmails: vi.fn() }));
vi.mock("@/services/card/pin-block-emails", () => emails);

const claimEmails = vi.hoisted(() => ({ sendCardClaimedFromWalletEmails: vi.fn() }));
vi.mock("@/services/card/holder-claim-emails", () => claimEmails);
vi.mock("@/services/card/publish-holder-name", () => ({ scheduleCardHolderNamePublish: vi.fn() }));
const apiSync = vi.hoisted(() => ({ scheduleMemberApiSync: vi.fn() }));
vi.mock("@/services/member/api-sync", () => apiSync);

import { POST } from "./route";

const SECRET = "topsecret";
const fund = {
  id: "fund-1",
  name: "Acme",
  domain: "acme.lacaisse.eu",
  timezone: "Europe/Brussels",
  primaryColor: null,
  logoUrl: null,
  senderEmail: null,
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "enc:apikey",
  citizenPayEventsSecretEnc: `enc:${SECRET}`,
  citizenPayTreasurySlug: "acme",
  memberLoginEnabled: true,
};
const localCard = {
  id: "card-1",
  serialNumber: "SER1",
  status: "ACTIVE",
  blockedReason: null,
  blockedAt: null,
  number: 7,
  holderName: null,
  memberId: "m1",
  member: { firstName: "Alex", lastName: "Dupont", email: "alex@example.org" },
};
const BLOCKED_AT = "2026-11-03T09:12:00.000Z";
const remote = (over: Record<string, unknown> = {}) => ({
  serialNumber: "SER1",
  status: "BLOCKED",
  owner: null,
  sourceSerial: null,
  pinBlockedAt: BLOCKED_AT,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivity: null,
  account: "0xabc",
  pinFailedAttempts: 3,
  pinBlockCount: 1,
  pinEvents: [
    { action: "blocked", by: "system", byRef: null, placeId: "place-9", terminalId: "t-1", at: BLOCKED_AT },
  ],
  ...over,
});

const NOW = new Date("2026-11-03T10:00:00Z");
const ts = () => String(Math.floor(Date.now() / 1000));

function payload(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    // The api sends a JSON number; see the schema.
    id: 1,
    type: "card.blocked",
    project: "acme",
    serial: "SER1",
    at: BLOCKED_AT,
    place_id: "place-9",
    terminal_id: "t-1",
    pin_block_count: 1,
    ...over,
  });
}

function post(
  body: string,
  opts: { timestamp?: string | null; signature?: string | null; secret?: string; fundHeader?: string } = {},
) {
  const timestamp = opts.timestamp === undefined ? ts() : opts.timestamp;
  const signature =
    opts.signature === undefined
      ? signEventsPayload(opts.secret ?? SECRET, timestamp ?? "", body)
      : opts.signature;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (timestamp !== null) headers["x-citizenpay-timestamp"] = timestamp;
  if (signature !== null) headers["x-citizenpay-signature"] = signature;
  // The proxy sets x-fund-id on the fund's host; "" = not a fund host.
  const fundHeader = opts.fundHeader === undefined ? "fund-1" : opts.fundHeader;
  if (fundHeader) headers["x-fund-id"] = fundHeader;
  return POST(
    new NextRequest("https://acme.lacaisse.eu/api/citizenpay/events", {
      method: "POST",
      body,
      headers,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  prisma.fund.findUnique.mockResolvedValue(fund);
  prisma.citizenPayEvent.create.mockImplementation(async ({ data }) => ({
    id: "row-1",
    outcome: "RECEIVED",
    ...data,
  }));
  prisma.citizenPayEvent.update.mockResolvedValue({});
  prisma.card.findFirst.mockResolvedValue(localCard);
  prisma.card.update.mockResolvedValue({});
  prisma.cardEvent.create.mockResolvedValue({});
  prisma.merchant.findFirst.mockResolvedValue({ name: "Bar Central" });
  cp.getCitizenPayCard.mockResolvedValue(remote());
  emails.sendCardPinBlockedEmails.mockResolvedValue({ staff: 2, holder: true });
  prisma.member.findFirst.mockResolvedValue(null);
  prisma.member.updateMany.mockResolvedValue({ count: 0 });
  prisma.cardHolderClaim.findMany.mockResolvedValue([]);
  prisma.cardHolderClaim.updateMany.mockResolvedValue({ count: 0 });
  prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  claimEmails.sendCardClaimedFromWalletEmails.mockResolvedValue(1);
  prisma.cardHolderClaim.count.mockResolvedValue(0);
});

describe("POST /api/citizenpay/events — the door", () => {
  it("400 on a body that is not an event", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ type: "card.blocked" }))).status).toBe(400);
    expect(prisma.citizenPayEvent.create).not.toHaveBeenCalled();
  });

  it("answers one generic 401 before the signature: no fund host, unknown fund, another fund's treasury, no secret", async () => {
    const generic = { error: "unauthorized" };
    const noHost = await post(payload(), { fundHeader: "" });
    expect(noHost.status).toBe(401);
    expect(await noHost.json()).toEqual(generic);

    prisma.fund.findUnique.mockResolvedValueOnce(null);
    const unknown = await post(payload());
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(generic);

    const other = await post(payload({ project: "other-fund" }));
    expect(other.status).toBe(401);
    expect(await other.json()).toEqual(generic);

    prisma.fund.findUnique.mockResolvedValueOnce({ ...fund, citizenPayEventsSecretEnc: null });
    const noSecret = await post(payload());
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toEqual(generic);

    expect(prisma.citizenPayEvent.create).not.toHaveBeenCalled();
    expect(cp.getCitizenPayCard).not.toHaveBeenCalled();
  });

  it("never looks a fund up from the payload: the host's fund is the fund, its slug only cross-checked", async () => {
    prisma.fund.findUnique.mockResolvedValue({ ...fund, citizenPayTreasurySlug: null });
    const res = await post(payload({ project: "anything" }));
    expect(res.status).toBe(200);
    expect(prisma.fund.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "fund-1" } }),
    );
  });

  it("401 on a wrong secret, a tampered body, a missing header", async () => {
    expect((await post(payload(), { secret: "other" })).status).toBe(401);
    const body = payload();
    const sig = signEventsPayload(SECRET, ts(), body);
    expect(
      (await post(body.replace("SER1", "SER2"), { signature: sig })).status,
    ).toBe(401);
    expect((await post(payload(), { signature: null })).status).toBe(401);
    expect(prisma.citizenPayEvent.create).not.toHaveBeenCalled();
    expect(cp.getCitizenPayCard).not.toHaveBeenCalled();
  });

  it("401 on a timestamp more than five minutes old (a replay)", async () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 600);
    const res = await post(payload(), { timestamp: old });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "skew" });
  });
});

describe("POST /api/citizenpay/events — idempotency", () => {
  it("claims the event id first (the api's number, kept as a string) and answers a redelivery without re-reading", async () => {
    const first = await post(payload());
    expect(first.status).toBe(200);
    expect(prisma.citizenPayEvent.create).toHaveBeenCalledWith({
      data: {
        fundId: "fund-1",
        eventId: "1",
        type: "card.blocked",
        serial: "SER1",
        occurredAt: new Date(BLOCKED_AT),
      },
      select: { id: true, outcome: true },
    });

    cp.getCitizenPayCard.mockClear();
    emails.sendCardPinBlockedEmails.mockClear();
    prisma.citizenPayEvent.create.mockRejectedValue({ code: "P2002" });
    prisma.citizenPayEvent.findUnique.mockResolvedValue({ id: "row-1", outcome: "APPLIED" });

    const again = await post(payload({ id: "1" }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true, outcome: "APPLIED" });
    expect(cp.getCitizenPayCard).not.toHaveBeenCalled();
    expect(emails.sendCardPinBlockedEmails).not.toHaveBeenCalled();
  });

  it("ignores an event for a fund that disconnected from Citizen Pay", async () => {
    prisma.fund.findUnique.mockResolvedValue({ ...fund, citizenPayApiKeyEnc: null });
    const res = await post(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "IGNORED" });
    expect(cp.getCitizenPayCard).not.toHaveBeenCalled();
  });

  it("handles a redelivery of an event whose first attempt FAILED", async () => {
    prisma.citizenPayEvent.create.mockRejectedValue({ code: "P2002" });
    prisma.citizenPayEvent.findUnique.mockResolvedValue({ id: "row-1", outcome: "FAILED" });

    const res = await post(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true, outcome: "APPLIED" });
    expect(cp.getCitizenPayCard).toHaveBeenCalledWith("SER1");
  });

  it("records FAILED and answers 500 (so the api retries) when the re-read fails", async () => {
    cp.getCitizenPayCard.mockRejectedValue(new Error("cp down"));
    const res = await post(payload());
    expect(res.status).toBe(500);
    expect(prisma.citizenPayEvent.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { outcome: "FAILED", detail: "cp down" },
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/citizenpay/events — re-read, then apply", () => {
  it("imports the PIN block the api confirms, writes the audit line and sends the emails once", async () => {
    const res = await post(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: false, outcome: "APPLIED" });

    expect(cp.getCitizenPayCard).toHaveBeenCalledWith("SER1");
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { status: "BLOCKED", blockedReason: "PIN", blockedAt: new Date(BLOCKED_AT) },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: {
        fundId: "fund-1",
        cardId: "card-1",
        kind: "PIN_BLOCKED",
        source: "WEBHOOK",
        actorUserId: null,
        citizenPayEventId: "1",
        placeId: "place-9",
        placeName: "Bar Central",
        terminalId: "t-1",
        at: new Date(BLOCKED_AT),
      },
    });
    expect(emails.sendCardPinBlockedEmails).toHaveBeenCalledTimes(1);
    expect(emails.sendCardPinBlockedEmails).toHaveBeenCalledWith({
      fund,
      card: localCard,
      eventId: "1",
      placeName: "Bar Central",
      blockedAt: new Date(BLOCKED_AT),
    });
    expect(prisma.citizenPayEvent.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: {
        outcome: "APPLIED",
        detail: "PIN block imported; 2 staff email(s), holder emailed",
      },
    });
  });

  it("never applies the payload: a card.blocked the api does not confirm changes nothing and mails no one", async () => {
    cp.getCitizenPayCard.mockResolvedValue(remote({ status: "ACTIVE", pinBlockedAt: null }));
    const res = await post(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "IGNORED" });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(emails.sendCardPinBlockedEmails).not.toHaveBeenCalled();
  });

  it("lifts a local PIN block when the api says active (out-of-order card.unblocked)", async () => {
    prisma.card.findFirst.mockResolvedValue({
      ...localCard,
      status: "BLOCKED",
      blockedReason: "PIN",
      blockedAt: new Date(BLOCKED_AT),
    });
    cp.getCitizenPayCard.mockResolvedValue(remote({ status: "ACTIVE", pinBlockedAt: null }));

    const res = await post(payload({ id: "evt_2", type: "card.unblocked", by: "member" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "APPLIED" });
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { status: "ACTIVE", blockedReason: null, blockedAt: null },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "PIN_UNBLOCKED", source: "WEBHOOK", citizenPayEventId: "evt_2" }),
    });
    expect(emails.sendCardPinBlockedEmails).not.toHaveBeenCalled();
  });

  it("leaves a fund block alone even when the api reports a PIN block", async () => {
    prisma.card.findFirst.mockResolvedValue({
      ...localCard,
      status: "BLOCKED",
      blockedReason: "FUND",
      blockedAt: new Date("2026-10-01T00:00:00Z"),
    });
    const res = await post(payload());
    expect(await res.json()).toMatchObject({ outcome: "IGNORED" });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(emails.sendCardPinBlockedEmails).not.toHaveBeenCalled();
  });

  it("ignores a card the fund has no row for, and types that are not card.*", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    expect(await (await post(payload())).json()).toMatchObject({ outcome: "IGNORED" });
    expect(cp.getCitizenPayCard).not.toHaveBeenCalled();

    prisma.card.findFirst.mockResolvedValue(localCard);
    expect(
      await (await post(payload({ id: "evt_3", type: "payout.settled" }))).json(),
    ).toMatchObject({ outcome: "IGNORED" });
    expect(cp.getCitizenPayCard).not.toHaveBeenCalled();
  });
});

describe("POST /api/citizenpay/events — holder events", () => {
  const LOGIN = "11111111-2222-3333-4444-555555555555";

  it("binds a card claimed from the wallet to this fund's member of that login, from the holder read", async () => {
    prisma.card.findFirst.mockResolvedValue({
      id: "card-1",
      serialNumber: "SER1",
      holderName: null,
      memberId: null,
      formerMemberId: null,
      member: null,
    });
    prisma.member.findFirst.mockResolvedValue({
      id: "m2",
      userId: LOGIN,
      firstName: "Alex",
      lastName: "Dupont",
      emailVerifiedAt: new Date("2026-10-01T00:00:00Z"),
    });
    cp.getCardHolder.mockResolvedValue({
      holderRef: LOGIN,
      attachedAt: BLOCKED_AT,
      proof: "fund",
      pendingHolderRef: null,
      pendingProof: null,
      pendingSince: null,
      pendingKnown: true,
      appOwnerLinked: false,
    });

    const res = await post(
      JSON.stringify({
        id: 77,
        type: "card.attached",
        project: "acme",
        serial: "SER1",
        holder_ref: LOGIN,
        proof: "fund",
        at: BLOCKED_AT,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: false, outcome: "APPLIED" });
    expect(cp.getCardHolder).toHaveBeenCalledWith("SER1");
    expect(cp.getCitizenPayCard).not.toHaveBeenCalled();
    expect(prisma.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fundId: "fund-1", userId: LOGIN } }),
    );
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { memberId: "m2", formerMemberId: null },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "HOLDER_ATTACHED",
        source: "WEBHOOK",
        citizenPayEventId: "77",
        detail: "fund",
      }),
      select: { id: true },
    });
    expect(claimEmails.sendCardClaimedFromWalletEmails).toHaveBeenCalledTimes(1);
    expect(emails.sendCardPinBlockedEmails).not.toHaveBeenCalled();
    expect(prisma.citizenPayEvent.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { outcome: "APPLIED", detail: "bound to member (proof: fund); 1 staff email(s)" },
    });
  });

  it("still routes card.blocked through the PIN path, untouched by the holder events", async () => {
    const res = await post(payload({ id: 78 }));
    expect(await res.json()).toEqual({ ok: true, duplicate: false, outcome: "APPLIED" });
    expect(cp.getCardHolder).not.toHaveBeenCalled();
    expect(cp.getCitizenPayCard).toHaveBeenCalledWith("SER1");
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { status: "BLOCKED", blockedReason: "PIN", blockedAt: new Date(BLOCKED_AT) },
    });
    expect(claimEmails.sendCardClaimedFromWalletEmails).not.toHaveBeenCalled();
  });
});
