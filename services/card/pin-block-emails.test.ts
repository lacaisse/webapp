// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Recipients and idempotency of the PIN-block emails: the fund's OWNER/ADMIN
// staff (deduplicated), the bound member when they have an email, one Email
// row per recipient per api event.
vi.mock("server-only", () => ({}));

const prisma = vi.hoisted(() => ({
  fundMember: { findMany: vi.fn() },
  email: { create: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const send = vi.hoisted(() => ({
  sendCardPinBlocked: vi.fn(),
  sendCardPinBlockedHolder: vi.fn(),
}));
vi.mock("@/services/email/transactional", () => send);

import { sendCardPinBlockedEmails, walletCardUrl } from "./pin-block-emails";

const fund = {
  id: "fund-1",
  name: "Acme",
  domain: "acme.lacaisse.eu",
  primaryColor: "#123456",
  logoUrl: null,
  senderEmail: "hello@acme.example",
  citizenPayTreasurySlug: "acme",
  timezone: "Europe/Brussels",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
};
const card = {
  id: "card-1",
  serialNumber: "SER1",
  number: 7,
  holderName: null,
  memberId: "m1",
  member: { firstName: "Alex", lastName: "Dupont", email: "alex@example.org" },
};
const blockedAt = new Date("2026-11-03T09:12:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  // The card link is built like every other cross-host fund link: https and
  // no port in production.
  vi.stubEnv("NODE_ENV", "production");
  process.env.APP_DOMAIN = "lacaisse.eu";
  prisma.fundMember.findMany.mockResolvedValue([
    { user: { email: "owner@acme.example" } },
    { user: { email: "admin@acme.example" } },
    { user: { email: "owner@acme.example" } }, // same person, two rows
  ]);
  let n = 0;
  prisma.email.create.mockImplementation(async () => ({ id: `email-${++n}` }));
  send.sendCardPinBlocked.mockResolvedValue(undefined);
  send.sendCardPinBlockedHolder.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendCardPinBlockedEmails", () => {
  it("mails each OWNER/ADMIN once and the holder, each on its own Email row", async () => {
    const out = await sendCardPinBlockedEmails({
      fund,
      card,
      eventId: "evt_1",
      placeName: "Bar Central",
      blockedAt,
    });
    expect(out).toEqual({ staff: 2, holder: true });

    expect(prisma.fundMember.findMany).toHaveBeenCalledWith({
      where: { fundId: "fund-1", role: { in: ["OWNER", "ADMIN"] } },
      select: { user: { select: { email: true } } },
    });
    expect(prisma.email.create).toHaveBeenCalledTimes(3);
    expect(prisma.email.create).toHaveBeenCalledWith({
      data: {
        fundId: "fund-1",
        type: "CARD_PIN_BLOCKED",
        toEmail: "owner@acme.example",
        cardId: "card-1",
        memberId: null,
        idempotencyKey: "CARD_PIN_BLOCKED:card:card-1:event:evt_1:to:owner@acme.example",
        subject: "Card",
      },
      select: { id: true },
    });
    expect(prisma.email.create).toHaveBeenCalledWith({
      data: {
        fundId: "fund-1",
        type: "CARD_PIN_BLOCKED_HOLDER",
        toEmail: "alex@example.org",
        cardId: "card-1",
        memberId: "m1",
        idempotencyKey: "CARD_PIN_BLOCKED_HOLDER:card:card-1:event:evt_1",
        subject: "Card",
      },
      select: { id: true },
    });

    expect(send.sendCardPinBlocked).toHaveBeenCalledTimes(2);
    expect(send.sendCardPinBlocked).toHaveBeenCalledWith({
      emailId: "email-1",
      fundId: "fund-1",
      toEmail: "owner@acme.example",
      fund: { name: "Acme", primaryColor: "#123456", logoUrl: null },
      serial: "SER1",
      holder: "Alex Dupont",
      place: "Bar Central",
      blockedAt: blockedAt.toISOString(),
      timeZone: "Europe/Brussels",
      cardUrl: "https://acme.lacaisse.eu/cards/card-1",
    });
    expect(send.sendCardPinBlockedHolder).toHaveBeenCalledWith({
      emailId: "email-3",
      fundId: "fund-1",
      toEmail: "alex@example.org",
      fund: {
        name: "Acme",
        primaryColor: "#123456",
        logoUrl: null,
        senderEmail: "hello@acme.example",
      },
      firstName: "Alex",
      place: "Bar Central",
      blockedAt: blockedAt.toISOString(),
      timeZone: "Europe/Brussels",
      walletUrl: "https://tap.citizenpay.eu/card/SER1?network=acme",
    });
  });

  it("skips the holder without a bound member or without an email", async () => {
    const noMember = await sendCardPinBlockedEmails({
      fund,
      card: { ...card, memberId: null, member: null },
      eventId: "evt_1",
      placeName: null,
      blockedAt,
    });
    expect(noMember).toEqual({ staff: 2, holder: false });
    expect(send.sendCardPinBlockedHolder).not.toHaveBeenCalled();

    vi.clearAllMocks();
    prisma.fundMember.findMany.mockResolvedValue([]);
    prisma.email.create.mockResolvedValue({ id: "email-x" });
    const noEmail = await sendCardPinBlockedEmails({
      fund,
      card: { ...card, member: { ...card.member, email: null } },
      eventId: "evt_1",
      placeName: null,
      blockedAt,
    });
    expect(noEmail).toEqual({ staff: 0, holder: false });
    expect(send.sendCardPinBlockedHolder).not.toHaveBeenCalled();
    expect(send.sendCardPinBlocked).not.toHaveBeenCalled();
  });

  it("never sends twice for the same event id (the Email row already exists)", async () => {
    prisma.email.create.mockRejectedValue({ code: "P2002" });
    const out = await sendCardPinBlockedEmails({
      fund,
      card,
      eventId: "evt_1",
      placeName: null,
      blockedAt,
    });
    expect(out).toEqual({ staff: 0, holder: false });
    expect(send.sendCardPinBlocked).not.toHaveBeenCalled();
    expect(send.sendCardPinBlockedHolder).not.toHaveBeenCalled();
  });

  it("passes an empty place through (the template names 'a terminal')", async () => {
    await sendCardPinBlockedEmails({ fund, card, eventId: "evt_2", placeName: null, blockedAt });
    expect(send.sendCardPinBlocked).toHaveBeenCalledWith(expect.objectContaining({ place: "" }));
  });
});

describe("walletCardUrl", () => {
  it("is the card wallet's card page, with the treasury hint when known", () => {
    expect(walletCardUrl("SER 1", null)).toBe("https://tap.citizenpay.eu/card/SER%201");
    expect(walletCardUrl("SER1", "acme")).toBe("https://tap.citizenpay.eu/card/SER1?network=acme");
  });
});
