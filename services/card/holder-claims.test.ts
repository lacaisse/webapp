// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The holder events on a stubbed Prisma and a stubbed Citizen Pay client:
// the holder read decides (never the payload), an attachment binds only this
// fund's member of that login, the fund's own attachments round-trip without
// a second line or email, a pending claim is one row per serial, and a
// detachment unbinds only a login-bound card our own rule says is attached.
vi.mock("server-only", () => ({}));

const prisma = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  member: { findFirst: vi.fn(), updateMany: vi.fn() },
  cardEvent: { create: vi.fn() },
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

const cp = vi.hoisted(() => ({ getCardHolder: vi.fn(), getCitizenPayCard: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const emails = vi.hoisted(() => ({ sendCardClaimedFromWalletEmails: vi.fn() }));
vi.mock("./holder-claim-emails", () => emails);

const apiSync = vi.hoisted(() => ({ scheduleMemberApiSync: vi.fn() }));
vi.mock("@/services/member/api-sync", () => apiSync);

const numbering = vi.hoisted(() => ({ nextCardNumber: vi.fn() }));
vi.mock("./numbering", () => numbering);

const publish = vi.hoisted(() => ({ scheduleCardHolderNamePublish: vi.fn() }));
vi.mock("./publish-holder-name", () => publish);

import { CitizenPayApiError } from "@/services/citizenpay/api";

import { handleCardHolderEvent, listCardHolderClaims } from "./holder-claims";

const LOGIN = "11111111-2222-3333-4444-555555555555";
const OTHER_LOGIN = "99999999-2222-3333-4444-555555555555";
const ATTACHED_AT = "2026-11-03T09:00:00.000Z";

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
  citizenPayEventsSecretEnc: "enc:s",
  citizenPayTreasurySlug: "acme",
  memberLoginEnabled: true,
};
const member = {
  id: "m1",
  userId: LOGIN,
  firstName: "Alex",
  lastName: "Dupont",
  emailVerifiedAt: new Date("2026-10-01T00:00:00Z"),
};
const unboundCard = {
  id: "card-1",
  serialNumber: "SER1",
  holderName: null,
  memberId: null,
  formerMemberId: null,
  member: null,
};
const boundCard = {
  ...unboundCard,
  memberId: "m1",
  member: { id: "m1", userId: LOGIN, emailVerifiedAt: member.emailVerifiedAt },
};
const noHolder = {
  holderRef: null,
  attachedAt: null,
  proof: null,
  pendingHolderRef: null,
  pendingProof: null,
  pendingSince: null,
  pendingKnown: true,
  appOwnerLinked: false,
};

function event(over: Record<string, unknown> = {}) {
  return {
    id: "41",
    type: "card.attached",
    project: "acme",
    serial: "ser1",
    at: ATTACHED_AT,
    holder_ref: LOGIN,
    proof: "payment",
    ...over,
  } as Parameters<typeof handleCardHolderEvent>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  prisma.card.findFirst.mockResolvedValue(unboundCard);
  prisma.card.create.mockResolvedValue({ ...unboundCard, id: "card-new" });
  prisma.card.update.mockResolvedValue({});
  prisma.member.findFirst.mockResolvedValue(member);
  prisma.member.updateMany.mockResolvedValue({ count: 0 });
  prisma.cardEvent.create.mockResolvedValue({ id: "ev-1" });
  prisma.cardHolderClaim.findMany.mockResolvedValue([]);
  prisma.cardHolderClaim.updateMany.mockResolvedValue({ count: 0 });
  prisma.cardHolderClaim.update.mockResolvedValue({});
  prisma.cardHolderClaim.create.mockResolvedValue({ id: "claim-new" });
  prisma.cardHolderClaim.count.mockResolvedValue(0);
  prisma.cardHolderClaim.findFirst.mockResolvedValue(null);
  cp.getCardHolder.mockResolvedValue({
    ...noHolder,
    holderRef: LOGIN,
    attachedAt: ATTACHED_AT,
    proof: "payment",
  });
  cp.getCitizenPayCard.mockResolvedValue(null);
  emails.sendCardClaimedFromWalletEmails.mockResolvedValue(2);
  numbering.nextCardNumber.mockResolvedValue(8);
});

describe("handleCardHolderEvent — attached", () => {
  it("binds this fund's member of that login, writes the audit line, mails staff, syncs the member", async () => {
    const res = await handleCardHolderEvent(fund, event());
    expect(res).toEqual({
      outcome: "APPLIED",
      detail: "bound to member (proof: payment); 2 staff email(s)",
    });
    expect(cp.getCardHolder).toHaveBeenCalledWith("ser1");
    expect(prisma.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fundId: "fund-1", userId: LOGIN } }),
    );
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { memberId: "m1", formerMemberId: null },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: {
        fundId: "fund-1",
        cardId: "card-1",
        kind: "HOLDER_ATTACHED",
        source: "WEBHOOK",
        actorUserId: null,
        citizenPayEventId: "41",
        detail: "payment",
        at: new Date(ATTACHED_AT),
      },
      select: { id: true },
    });
    expect(emails.sendCardClaimedFromWalletEmails).toHaveBeenCalledWith({
      fund,
      card: unboundCard,
      member,
      eventId: "41",
      proof: "payment",
      claimedAt: new Date(ATTACHED_AT),
    });
    // The claimant's pending claims settle as ATTACHED.
    expect(prisma.cardHolderClaim.updateMany).toHaveBeenCalledWith({
      where: { fundId: "fund-1", serial: "SER1", status: "PENDING", holderRef: LOGIN },
      data: { status: "ATTACHED", decidedAt: expect.any(Date) },
    });
    expect(apiSync.scheduleMemberApiSync).toHaveBeenCalledWith("m1");
  });

  it("takes a card from its previous member and clears that member's primary pointer", async () => {
    prisma.card.findFirst.mockResolvedValue({
      ...unboundCard,
      memberId: "m-old",
      member: { id: "m-old", userId: null, emailVerifiedAt: null },
    });
    const res = await handleCardHolderEvent(fund, event());
    expect(res.outcome).toBe("APPLIED");
    expect(prisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: "m-old", primaryCardId: "card-1" },
      data: { primaryCardId: null },
    });
    expect(apiSync.scheduleMemberApiSync).toHaveBeenCalledWith(["m1", "m-old"]);
  });

  it("ignores (and warns about) a login that is no member of this fund", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    prisma.member.findFirst.mockResolvedValue(null);
    const res = await handleCardHolderEvent(fund, event());
    expect(res).toEqual({ outcome: "IGNORED", detail: "holder is not a member of this fund" });
    expect(warn).toHaveBeenCalled();
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(prisma.cardEvent.create).not.toHaveBeenCalled();
    expect(emails.sendCardClaimedFromWalletEmails).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never binds another fund's member of the same login: the lookup is fund-scoped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const otherFundMember = { ...member, id: "m-other", fundId: "fund-2" };
    prisma.member.findFirst.mockImplementation(async ({ where }) =>
      where.fundId === "fund-2" && where.userId === LOGIN ? otherFundMember : null,
    );
    const res = await handleCardHolderEvent(fund, event());
    expect(res.outcome).toBe("IGNORED");
    expect(prisma.member.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.member.findFirst.mock.calls[0][0].where).toEqual({
      fundId: "fund-1",
      userId: LOGIN,
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("changes nothing on a card already bound to that member, but settles the open claim", async () => {
    prisma.card.findFirst.mockResolvedValue(boundCard);
    const res = await handleCardHolderEvent(fund, event({ proof: "fund" }));
    expect(res).toEqual({ outcome: "IGNORED", detail: "already bound to this login" });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(prisma.cardEvent.create).not.toHaveBeenCalled();
    expect(emails.sendCardClaimedFromWalletEmails).not.toHaveBeenCalled();
    expect(prisma.cardHolderClaim.updateMany).toHaveBeenCalledWith({
      where: { fundId: "fund-1", serial: "SER1", status: "PENDING", holderRef: LOGIN },
      data: { status: "ATTACHED", decidedAt: expect.any(Date) },
    });
  });

  it("creates the card row for a serial the fund has none for, then binds it", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    cp.getCitizenPayCard.mockResolvedValue({
      serialNumber: "SER1",
      status: "ACTIVE",
      owner: null,
      sourceSerial: null,
      pinBlockedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivity: null,
      account: "0xabc",
      pinFailedAttempts: null,
      pinBlockCount: null,
      pinEvents: [],
    });
    const res = await handleCardHolderEvent(fund, event());
    expect(res.outcome).toBe("APPLIED");
    expect(prisma.card.create).toHaveBeenCalledWith({
      data: {
        fundId: "fund-1",
        memberId: null,
        serialNumber: "SER1",
        account: "0xabc",
        number: 8,
        holderName: null,
        status: "ACTIVE",
        sourceSerial: null,
        issuedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      select: expect.any(Object),
    });
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-new" },
      data: { memberId: "m1", formerMemberId: null },
    });
  });

  it("re-finds the card that won a unique race instead of failing", async () => {
    prisma.card.findFirst
      .mockResolvedValueOnce(null) // before the create
      .mockResolvedValueOnce({ ...unboundCard, id: "card-raced" }); // after the P2002
    prisma.card.create.mockRejectedValueOnce({ code: "P2002" });
    cp.getCitizenPayCard.mockRejectedValue(new Error("cp down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleCardHolderEvent(fund, event());
    expect(res.outcome).toBe("APPLIED");
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-raced" },
      data: { memberId: "m1", formerMemberId: null },
    });
    err.mockRestore();
  });

  it("ignores a card.attached the holder read does not confirm", async () => {
    cp.getCardHolder.mockResolvedValue(noHolder);
    const res = await handleCardHolderEvent(fund, event());
    expect(res).toEqual({
      outcome: "IGNORED",
      detail: "api does not confirm the attachment (already detached)",
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(emails.sendCardClaimedFromWalletEmails).not.toHaveBeenCalled();
  });

  it("ignores a serial that is not the issuer's at Citizen Pay (404) and throws on other errors", async () => {
    cp.getCardHolder.mockRejectedValueOnce(new CitizenPayApiError("nope", 404, null));
    expect(await handleCardHolderEvent(fund, event())).toEqual({
      outcome: "IGNORED",
      detail: "card not the issuer's at Citizen Pay",
    });
    cp.getCardHolder.mockRejectedValueOnce(new CitizenPayApiError("boom", 500, null));
    await expect(handleCardHolderEvent(fund, event())).rejects.toThrow("boom");
  });

  it("ignores everything for a fund that disconnected from Citizen Pay", async () => {
    const res = await handleCardHolderEvent({ ...fund, citizenPayApiKeyEnc: null }, event());
    expect(res.outcome).toBe("IGNORED");
    expect(cp.getCardHolder).not.toHaveBeenCalled();
  });
});

describe("handleCardHolderEvent — pending", () => {
  const pendingRead = {
    ...noHolder,
    pendingHolderRef: LOGIN,
    pendingProof: "pending",
    pendingSince: "2026-11-03T08:00:00.000Z",
  };

  it("opens one PENDING claim from the holder read and writes CLAIM_PENDING on the card", async () => {
    cp.getCardHolder.mockResolvedValue(pendingRead);
    const res = await handleCardHolderEvent(
      fund,
      event({ type: "card.claim_pending", proof: null }),
    );
    expect(res).toEqual({ outcome: "APPLIED", detail: "claim pending (fund to confirm)" });
    expect(prisma.cardHolderClaim.create).toHaveBeenCalledWith({
      data: {
        fundId: "fund-1",
        serial: "SER1",
        cardId: "card-1",
        holderRef: LOGIN,
        memberId: "m1",
        proof: "pending",
        status: "PENDING",
        citizenPayEventId: "41",
        requestedAt: new Date("2026-11-03T08:00:00.000Z"),
      },
      select: { id: true },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "CLAIM_PENDING", source: "WEBHOOK", detail: "pending" }),
      select: { id: true },
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(prisma.card.create).not.toHaveBeenCalled();
  });

  it("refreshes the open claim on a redelivery instead of opening a second", async () => {
    cp.getCardHolder.mockResolvedValue(pendingRead);
    prisma.cardHolderClaim.findMany.mockResolvedValue([{ id: "claim-1", holderRef: LOGIN }]);
    const res = await handleCardHolderEvent(
      fund,
      event({ id: "42", type: "card.attached", proof: "pending" }),
    );
    expect(res.outcome).toBe("APPLIED");
    expect(prisma.cardHolderClaim.create).not.toHaveBeenCalled();
    expect(prisma.cardHolderClaim.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: expect.objectContaining({ citizenPayEventId: "42", proof: "pending" }),
    });
    expect(prisma.cardEvent.create).not.toHaveBeenCalled();
  });

  it("supersedes another claimant's open claim", async () => {
    cp.getCardHolder.mockResolvedValue(pendingRead);
    prisma.cardHolderClaim.findMany.mockResolvedValue([{ id: "claim-0", holderRef: OTHER_LOGIN }]);
    await handleCardHolderEvent(fund, event({ type: "card.claim_pending" }));
    expect(prisma.cardHolderClaim.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["claim-0"] }, status: "PENDING" },
      data: { status: "SUPERSEDED", decidedAt: expect.any(Date) },
    });
    expect(prisma.cardHolderClaim.create).toHaveBeenCalled();
  });

  it("falls back on a card.claim_pending payload when the holder read shows nothing yet", async () => {
    cp.getCardHolder.mockResolvedValue(noHolder);
    prisma.card.findFirst.mockResolvedValue(null);
    const res = await handleCardHolderEvent(
      fund,
      event({ type: "card.claim_pending", proof: null }),
    );
    expect(res).toEqual({ outcome: "APPLIED", detail: "claim pending (fund to confirm)" });
    expect(prisma.cardHolderClaim.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cardId: null,
        holderRef: LOGIN,
        requestedAt: new Date(ATTACHED_AT),
      }),
      select: { id: true },
    });
    // No card row is created for a pending claim, so no audit line either.
    expect(prisma.card.create).not.toHaveBeenCalled();
    expect(prisma.cardEvent.create).not.toHaveBeenCalled();
  });
});

describe("handleCardHolderEvent — detached", () => {
  beforeEach(() => {
    cp.getCardHolder.mockResolvedValue(noHolder);
  });

  it("unbinds a login-bound card, writes HOLDER_DETACHED and supersedes open claims", async () => {
    prisma.card.findFirst.mockResolvedValue(boundCard);
    prisma.member.updateMany.mockResolvedValue({ count: 1 });
    const res = await handleCardHolderEvent(fund, event({ type: "card.detached", proof: null }));
    expect(res).toEqual({
      outcome: "APPLIED",
      detail: "holder detached; card unbound from its member",
    });
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { memberId: null, formerMemberId: "m1" },
    });
    expect(prisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", primaryCardId: "card-1" },
      data: { primaryCardId: null },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "HOLDER_DETACHED",
        source: "WEBHOOK",
        citizenPayEventId: "41",
      }),
      select: { id: true },
    });
    expect(prisma.cardHolderClaim.updateMany).toHaveBeenCalledWith({
      where: { fundId: "fund-1", serial: "SER1", status: "PENDING" },
      data: { status: "SUPERSEDED", decidedAt: expect.any(Date) },
    });
    expect(apiSync.scheduleMemberApiSync).toHaveBeenCalledWith("m1");
  });

  it("leaves a card bound to a member without login alone", async () => {
    prisma.card.findFirst.mockResolvedValue({
      ...boundCard,
      member: { id: "m1", userId: null, emailVerifiedAt: null },
    });
    const res = await handleCardHolderEvent(fund, event({ type: "card.detached" }));
    expect(res).toEqual({ outcome: "IGNORED", detail: "card bound to a member without login" });
    expect(prisma.card.update).not.toHaveBeenCalled();
  });

  it("leaves the binding alone when our own rule says detached (the holder sync's DELETE echoing back)", async () => {
    prisma.card.findFirst.mockResolvedValue(boundCard);
    const res = await handleCardHolderEvent(
      { ...fund, memberLoginEnabled: false },
      event({ type: "card.detached" }),
    );
    expect(res.outcome).toBe("IGNORED");
    expect(prisma.card.update).not.toHaveBeenCalled();
  });

  it("ignores an unbound card", async () => {
    const res = await handleCardHolderEvent(fund, event({ type: "card.detached" }));
    expect(res).toEqual({ outcome: "IGNORED", detail: "already detached" });
  });
});

describe("listCardHolderClaims", () => {
  it("lists pending oldest first, then decided newest first", async () => {
    const row = (id: string, status: string, requestedAt: string, decidedAt: string | null) => ({
      id,
      status,
      serial: "SER1",
      cardId: null,
      holderRef: LOGIN,
      proof: "pending",
      requestedAt: new Date(requestedAt),
      decidedAt: decidedAt ? new Date(decidedAt) : null,
      card: null,
      member: null,
    });
    prisma.cardHolderClaim.findMany.mockResolvedValue([
      row("old-decided", "REFUSED", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
      row("p1", "PENDING", "2026-10-05T00:00:00Z", null),
      row("new-decided", "CONFIRMED", "2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z"),
      row("p2", "PENDING", "2026-10-08T00:00:00Z", null),
    ]);
    const items = await listCardHolderClaims("fund-1");
    expect(items.map((i) => i.id)).toEqual(["p1", "p2", "new-decided", "old-decided"]);
    expect(items[0]).toMatchObject({ cardNumber: null, member: null });
  });
});

describe("handleCardHolderEvent — review round 1", () => {
  it("sends no staff email for the fund's own confirmation, nor for a claim it already holds", async () => {
    cp.getCardHolder.mockResolvedValue({
      ...noHolder,
      holderRef: LOGIN,
      attachedAt: ATTACHED_AT,
      proof: "confirmed",
    });
    let res = await handleCardHolderEvent(fund, event({ proof: "confirmed" }));
    expect(res.outcome).toBe("APPLIED");
    expect(emails.sendCardClaimedFromWalletEmails).not.toHaveBeenCalled();

    cp.getCardHolder.mockResolvedValue({
      ...noHolder,
      holderRef: LOGIN,
      attachedAt: ATTACHED_AT,
      proof: "payment",
    });
    prisma.cardHolderClaim.count.mockResolvedValue(1);
    res = await handleCardHolderEvent(fund, event());
    expect(res.outcome).toBe("APPLIED");
    expect(prisma.cardHolderClaim.count).toHaveBeenCalledWith({
      where: { fundId: "fund-1", serial: "SER1", holderRef: LOGIN, status: { in: ["PENDING", "CONFIRMED"] } },
    });
    expect(emails.sendCardClaimedFromWalletEmails).not.toHaveBeenCalled();
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, "card-1");
  });

  it("binds nothing while member login is off at the fund", async () => {
    const res = await handleCardHolderEvent({ ...fund, memberLoginEnabled: false }, event());
    expect(res).toEqual({ outcome: "IGNORED", detail: "member login is off at this fund" });
    expect(prisma.card.update).not.toHaveBeenCalled();
  });

  it("gives a member without a primary card this one", async () => {
    await handleCardHolderEvent(fund, event());
    expect(prisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", primaryCardId: null },
      data: { primaryCardId: "card-1" },
    });
  });

  it("reads a P2002 on the pending claim as a concurrent delivery and refreshes that row", async () => {
    cp.getCardHolder.mockResolvedValue({
      ...noHolder,
      pendingHolderRef: LOGIN,
      pendingProof: "pending",
      pendingSince: ATTACHED_AT,
    });
    prisma.cardHolderClaim.create.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    prisma.cardHolderClaim.findFirst.mockResolvedValueOnce({ id: "claim-raced" });
    const res = await handleCardHolderEvent(fund, event({ type: "card.claim_pending", proof: "pending" }));
    expect(res).toEqual({
      outcome: "APPLIED",
      detail: "claim pending (fund to confirm); already on file, refreshed",
    });
    expect(prisma.cardHolderClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "claim-raced" } }),
    );
  });

  it("leaves open claims alone when the holder read does not expose the pending field", async () => {
    prisma.card.findFirst.mockResolvedValue(unboundCard);
    cp.getCardHolder.mockResolvedValue({ ...noHolder, pendingKnown: false });
    await handleCardHolderEvent(fund, event({ type: "card.attached" }));
    expect(prisma.cardHolderClaim.updateMany).not.toHaveBeenCalled();
    await handleCardHolderEvent(fund, event({ type: "card.detached" }));
    expect(prisma.cardHolderClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUPERSEDED" }) }),
    );
  });
});
