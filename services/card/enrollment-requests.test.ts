// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Cross-fund card enrollment service. Prisma, CitizenPay, email and the
// holder-name publish are faked; the tests pin the query shapes and the
// state machine (PENDING → ACCEPTED / REJECTED / CANCELLED).
vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const email = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@/services/email/resend", () => email);

const publish = vi.hoisted(() => ({ scheduleCardHolderNamePublish: vi.fn() }));
vi.mock("@/services/card/publish-holder-name", () => publish);

const cp = vi.hoisted(() => ({ registerCard: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const numbering = vi.hoisted(() => ({ nextCardNumber: vi.fn() }));
vi.mock("@/services/card/numbering", () => numbering);

const notify = vi.hoisted(() => ({ sendCardAssignedEmailSafe: vi.fn() }));
vi.mock("@/services/card/notify", () => notify);

const prisma = vi.hoisted(() => {
  const p = {
    card: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    cardEnrollmentRequest: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    fund: { findUnique: vi.fn() },
    fundMember: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p));
  return p;
});
vi.mock("@/services/db/prisma", () => ({ prisma }));

import {
  acceptCardEnrollmentRequest,
  cancelCardEnrollmentRequest,
  findForeignCards,
  listIncomingRequests,
  rejectCardEnrollmentRequest,
  requestCardEnrollment,
  type ForeignCard,
} from "./enrollment-requests";

const issuerFund = { id: "fund-issuer", name: "Issuer", domain: "issuer.lacaisse.eu" };
const requesterFund = { id: "fund-req", name: "Requester", domain: "req.lacaisse.eu" };
const foreignCard: ForeignCard = {
  id: "card-issuer",
  fundId: issuerFund.id,
  serialNumber: "04AABB",
  fund: issuerFund,
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.fundMember.findMany.mockResolvedValue([]);
});

describe("findForeignCards", () => {
  it("excludes the caller's fund and matches serials case-insensitively", async () => {
    prisma.card.findMany.mockResolvedValue([
      {
        id: "c1",
        fundId: issuerFund.id,
        serialNumber: "04aabb", // legacy lower-case row
        createdAt: new Date("2026-01-01"),
        fund: issuerFund,
        enrolledFromRequest: null,
      },
    ]);

    const out = await findForeignCards(requesterFund.id, ["04AABB", "04AABB", " 04ccdd "]);

    const args = prisma.card.findMany.mock.calls[0][0];
    expect(args.where.fundId).toEqual({ not: requesterFund.id });
    expect(args.where.OR).toEqual([
      { serialNumber: { equals: "04AABB", mode: "insensitive" } },
      { serialNumber: { equals: "04CCDD", mode: "insensitive" } },
    ]);
    expect([...out.keys()]).toEqual(["04AABB"]);
    expect(out.get("04AABB")).toEqual({
      id: "c1",
      fundId: issuerFund.id,
      serialNumber: "04aabb",
      fund: issuerFund,
    });
  });

  it("prefers the issuer row over a row enrolled from a request", async () => {
    prisma.card.findMany.mockResolvedValue([
      {
        id: "enrolled",
        fundId: "fund-other",
        serialNumber: "04AABB",
        createdAt: new Date("2025-01-01"),
        fund: { id: "fund-other", name: "Other", domain: "o.lacaisse.eu" },
        enrolledFromRequest: { id: "r0" },
      },
      {
        id: "issuer",
        fundId: issuerFund.id,
        serialNumber: "04AABB",
        createdAt: new Date("2026-01-01"),
        fund: issuerFund,
        enrolledFromRequest: null,
      },
    ]);
    const out = await findForeignCards(requesterFund.id, ["04AABB"]);
    expect(out.get("04AABB")?.id).toBe("issuer");
  });

  it("does not query for an empty list", async () => {
    const out = await findForeignCards(requesterFund.id, []);
    expect(out.size).toBe(0);
    expect(prisma.card.findMany).not.toHaveBeenCalled();
  });
});

describe("requestCardEnrollment", () => {
  const input = {
    requesterFund,
    requestedById: "user-1",
    card: foreignCard,
    requestedNumber: 12,
    memberId: "m1",
    holderName: " Jane Doe ",
  };

  it("creates a PENDING request against the issuer fund and emails its admins", async () => {
    prisma.cardEnrollmentRequest.findUnique.mockResolvedValue(null);
    prisma.cardEnrollmentRequest.create.mockResolvedValue({ id: "r1", status: "PENDING" });
    prisma.fundMember.findMany.mockResolvedValue([
      { user: { email: "owner@issuer.org" } },
      { user: { email: "admin@issuer.org" } },
    ]);

    const res = await requestCardEnrollment(input);

    expect(res).toEqual({ id: "r1", status: "PENDING" });
    expect(prisma.cardEnrollmentRequest.create.mock.calls[0][0].data).toEqual({
      cardId: "card-issuer",
      issuerFundId: issuerFund.id,
      requesterFundId: requesterFund.id,
      requestedById: "user-1",
      requestedNumber: 12,
      memberId: "m1",
      holderName: "Jane Doe",
      status: "PENDING",
    });
    expect(prisma.fundMember.findMany.mock.calls[0][0].where).toEqual({
      fundId: issuerFund.id,
      role: { in: ["OWNER", "ADMIN"] },
    });
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    expect(email.sendEmail.mock.calls.map((c) => c[0].to)).toEqual([
      "owner@issuer.org",
      "admin@issuer.org",
    ]);
    expect(email.sendEmail.mock.calls[0][0].subject).toBe(
      "cards.admin.enrollmentRequest.email.subject",
    );
  });

  it("refreshes an existing PENDING request's details without emailing again", async () => {
    prisma.cardEnrollmentRequest.findUnique.mockResolvedValue({
      id: "r1",
      status: "PENDING",
      enrolledCardId: null,
    });
    prisma.cardEnrollmentRequest.update.mockResolvedValue({ id: "r1", status: "PENDING" });
    prisma.fundMember.findMany.mockResolvedValue([{ user: { email: "owner@issuer.org" } }]);

    const res = await requestCardEnrollment({ ...input, requestedNumber: 40, memberId: "m2" });

    expect(res).toEqual({ id: "r1", status: "PENDING" });
    expect(prisma.cardEnrollmentRequest.update).toHaveBeenCalledTimes(1);
    expect(prisma.cardEnrollmentRequest.update.mock.calls[0][0]).toEqual({
      where: { id: "r1", status: "PENDING" },
      data: {
        requestedById: "user-1",
        requestedNumber: 40,
        memberId: "m2",
        holderName: "Jane Doe",
      },
      select: { id: true, status: true },
    });
    expect(prisma.cardEnrollmentRequest.create).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("revives a REJECTED request back to PENDING with the new details", async () => {
    prisma.cardEnrollmentRequest.findUnique.mockResolvedValue({
      id: "r1",
      status: "REJECTED",
      enrolledCardId: null,
    });
    prisma.cardEnrollmentRequest.update.mockResolvedValue({ id: "r1", status: "PENDING" });
    prisma.fundMember.findMany.mockResolvedValue([{ user: { email: "owner@issuer.org" } }]);

    const res = await requestCardEnrollment(input);

    expect(res).toEqual({ id: "r1", status: "PENDING" });
    const call = prisma.cardEnrollmentRequest.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "r1" });
    expect(call.data).toMatchObject({
      status: "PENDING",
      decidedById: null,
      decidedAt: null,
      requestedNumber: 12,
      memberId: "m1",
      holderName: "Jane Doe",
    });
    expect(prisma.cardEnrollmentRequest.create).not.toHaveBeenCalled();
    expect(email.sendEmail).toHaveBeenCalled();
  });

  it("never throws when the notification email fails", async () => {
    prisma.cardEnrollmentRequest.findUnique.mockResolvedValue(null);
    prisma.cardEnrollmentRequest.create.mockResolvedValue({ id: "r1", status: "PENDING" });
    prisma.fundMember.findMany.mockResolvedValue([{ user: { email: "a@b.org" } }]);
    email.sendEmail.mockRejectedValue(new Error("resend down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(requestCardEnrollment(input)).resolves.toEqual({
      id: "r1",
      status: "PENDING",
    });
    spy.mockRestore();
  });
});

describe("acceptCardEnrollmentRequest", () => {
  const pending = {
    id: "r1",
    status: "PENDING",
    requesterFundId: requesterFund.id,
    requestedNumber: 12,
    holderName: null,
    card: { serialNumber: "04AABB" },
    member: {
      id: "m1",
      fundId: requesterFund.id,
      email: "jane@req.org",
      firstName: "Jane",
      lastName: "Doe",
      address: null,
      postalCode: null,
      city: null,
    },
  };
  const connectedFund = {
    ...requesterFund,
    citizenPayFundId: "cp-req",
    citizenPayApiKeyId: "0xkey",
    citizenPayApiKeyEnc: "v1:enc",
    confirmationEmailsPausedAt: null,
  };
  const p2002 = () => Object.assign(new Error("unique"), { code: "P2002" });
  const args = { requestId: "r1", issuerFundId: issuerFund.id, decidedById: "user-2" };

  beforeEach(() => {
    prisma.cardEnrollmentRequest.findFirst.mockResolvedValue(pending);
    prisma.fund.findUnique.mockResolvedValue(connectedFund);
    cp.registerCard.mockResolvedValue({ serialNumber: "04AABB", account: "0xacc", status: "INACTIVE" });
    prisma.card.create.mockImplementation(async (a: { data: { number: number } }) => ({
      id: "card-new",
      serialNumber: "04AABB",
      number: a.data.number,
    }));
    prisma.card.updateMany.mockResolvedValue({ count: 0 });
    prisma.cardEnrollmentRequest.updateMany.mockResolvedValue({ count: 1 });
    numbering.nextCardNumber.mockResolvedValue(99);
  });

  // card.findFirst is used for the pre-CP local check, then the in-tx local
  // check (once per transaction attempt). No local row by default.
  beforeEach(() => {
    prisma.card.findFirst.mockResolvedValue(null);
  });

  it("enrolls at CP with the requester's creds and creates the card with the requested number", async () => {
    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-new" });
    expect(prisma.cardEnrollmentRequest.findFirst.mock.calls[0][0].where).toEqual({
      id: "r1",
      issuerFundId: issuerFund.id,
    });
    expect(cp.registerCard).toHaveBeenCalledWith({
      serialNumber: "04AABB",
      fundId: requesterFund.id,
      fundCitizenPayId: "cp-req",
      holderName: "Jane Doe",
    });
    expect(prisma.card.create.mock.calls[0][0].data).toMatchObject({
      fundId: requesterFund.id,
      memberId: "m1",
      serialNumber: "04AABB",
      account: "0xacc",
      number: 12,
      holderName: "Jane Doe",
      status: "INACTIVE",
    });
    expect(numbering.nextCardNumber).not.toHaveBeenCalled();
    expect(prisma.card.updateMany.mock.calls[0][0]).toEqual({
      where: { fundId: requesterFund.id, number: 12 },
      data: { number: null },
    });
    const decided = prisma.cardEnrollmentRequest.updateMany.mock.calls[0][0];
    expect(decided.where).toEqual({ id: "r1", status: "PENDING" });
    expect(decided.data).toMatchObject({
      status: "ACCEPTED",
      decidedById: "user-2",
      enrolledCardId: "card-new",
    });
    expect(decided.data.decidedAt).toBeInstanceOf(Date);
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(
      connectedFund,
      "card-new",
    );
  });

  it("takes the requested number from the requester card holding it, in the same tx", async () => {
    const order: string[] = [];
    prisma.$transaction.mockImplementationOnce(async (fn: (tx: typeof prisma) => unknown) => {
      order.push("tx:start");
      const out = await fn(prisma);
      order.push("tx:end");
      return out;
    });
    prisma.card.updateMany.mockImplementationOnce(async () => {
      order.push("free");
      return { count: 1 };
    });
    prisma.card.create.mockImplementationOnce(async (a: { data: { number: number } }) => {
      order.push("create");
      return { id: "card-new", serialNumber: "04AABB", number: a.data.number };
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-new" });
    expect(order).toEqual(["tx:start", "free", "create", "tx:end"]);
    expect(prisma.card.updateMany.mock.calls[0][0]).toEqual({
      where: { fundId: requesterFund.id, number: 12 },
      data: { number: null },
    });
    expect(prisma.card.create.mock.calls[0][0].data.number).toBe(12);
    expect(numbering.nextCardNumber).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("uses nextCardNumber when no number was requested", async () => {
    prisma.cardEnrollmentRequest.findFirst.mockResolvedValue({ ...pending, requestedNumber: null });

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-new" });
    expect(numbering.nextCardNumber).toHaveBeenCalledWith(requesterFund.id);
    expect(prisma.card.updateMany).not.toHaveBeenCalled();
    expect(prisma.card.create.mock.calls[0][0].data.number).toBe(99);
  });

  it("retries with a fresh number when the auto number loses a unique race", async () => {
    prisma.cardEnrollmentRequest.findFirst.mockResolvedValue({ ...pending, requestedNumber: null });
    numbering.nextCardNumber.mockResolvedValueOnce(99).mockResolvedValueOnce(100);
    prisma.card.create.mockRejectedValueOnce(p2002());

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-new" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.card.create.mock.calls.map((c) => c[0].data.number)).toEqual([99, 100]);
    expect(prisma.cardEnrollmentRequest.updateMany).toHaveBeenCalledTimes(1);
  });

  it("returns failed after three lost unique races", async () => {
    prisma.cardEnrollmentRequest.findFirst.mockResolvedValue({ ...pending, requestedNumber: null });
    prisma.card.create.mockRejectedValue(p2002());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ error: "failed" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(prisma.cardEnrollmentRequest.updateMany).not.toHaveBeenCalled();
    expect(notify.sendCardAssignedEmailSafe).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reuses the serial row that won the race on retry", async () => {
    prisma.card.findFirst
      .mockResolvedValueOnce(null) // pre-CP: no local row
      .mockResolvedValueOnce(null) // tx 1: no local row
      .mockResolvedValueOnce({
        id: "card-raced",
        serialNumber: "04AABB",
        number: 5,
        memberId: "m1",
        account: "0xacc",
      }); // tx 2: the concurrent create landed
    prisma.card.create.mockRejectedValueOnce(p2002());

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-raced" });
    expect(prisma.card.create).toHaveBeenCalledTimes(1);
    // Already bound by the row that won: no card-assigned email from us.
    expect(notify.sendCardAssignedEmailSafe).not.toHaveBeenCalled();
  });

  it("sends the card-assigned email once to the member the accept bound the card to", async () => {
    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-new" });
    expect(notify.sendCardAssignedEmailSafe).toHaveBeenCalledTimes(1);
    expect(notify.sendCardAssignedEmailSafe).toHaveBeenCalledWith({
      fund: connectedFund,
      card: { id: "card-new", serialNumber: "04AABB", number: 12 },
      member: pending.member,
      logTag: "card-enrollment",
    });
  });

  it("sends no card-assigned email when the request carries no member", async () => {
    prisma.cardEnrollmentRequest.findFirst.mockResolvedValue({
      ...pending,
      member: null,
      holderName: "Jane Doe",
    });

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-new" });
    expect(prisma.card.create.mock.calls[0][0].data.memberId).toBeNull();
    expect(notify.sendCardAssignedEmailSafe).not.toHaveBeenCalled();
  });

  it("still creates the card (account null) when CP enrollment fails", async () => {    cp.registerCard.mockRejectedValue(new Error("cp down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-new" });
    expect(prisma.card.create.mock.calls[0][0].data.account).toBeNull();
    spy.mockRestore();
  });

  it("reuses a card the requester fund already holds for the serial", async () => {
    const local = {
      id: "card-local",
      serialNumber: "04AABB",
      number: 3,
      memberId: null,
      account: null,
    };
    prisma.card.findFirst.mockResolvedValue(local);

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-local" });
    expect(cp.registerCard).not.toHaveBeenCalled();
    expect(prisma.card.create).not.toHaveBeenCalled();
    expect(prisma.card.update.mock.calls[0][0]).toEqual({
      where: { id: "card-local" },
      data: { memberId: "m1", holderName: "Jane Doe" },
    });
    // The accept bound the member to the reused row: it gets the email.
    expect(notify.sendCardAssignedEmailSafe).toHaveBeenCalledTimes(1);
    expect(notify.sendCardAssignedEmailSafe.mock.calls[0][0].card).toEqual({
      id: "card-local",
      serialNumber: "04AABB",
      number: 3,
    });
  });

  it("sends no card-assigned email when the reused row was already bound", async () => {
    prisma.card.findFirst.mockResolvedValue({
      id: "card-local",
      serialNumber: "04AABB",
      number: 3,
      memberId: "m-other",
      account: "0xacc",
    });

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ ok: true, enrolledCardId: "card-local" });
    expect(prisma.card.update).not.toHaveBeenCalled();
    expect(notify.sendCardAssignedEmailSafe).not.toHaveBeenCalled();
  });

  it("returns requesterNotConnected (and stays PENDING) when the requester has no CP treasury", async () => {
    prisma.fund.findUnique.mockResolvedValue({ ...connectedFund, citizenPayFundId: null });

    const res = await acceptCardEnrollmentRequest(args);

    expect(res).toEqual({ error: "requesterNotConnected" });
    expect(cp.registerCard).not.toHaveBeenCalled();
    expect(prisma.card.create).not.toHaveBeenCalled();
    expect(prisma.cardEnrollmentRequest.updateMany).not.toHaveBeenCalled();
  });

  it("returns notFound for a request of another issuer fund, notPending once decided", async () => {
    prisma.cardEnrollmentRequest.findFirst.mockResolvedValueOnce(null);
    expect(await acceptCardEnrollmentRequest(args)).toEqual({ error: "notFound" });

    prisma.cardEnrollmentRequest.findFirst.mockResolvedValueOnce({ ...pending, status: "REJECTED" });
    expect(await acceptCardEnrollmentRequest(args)).toEqual({ error: "notPending" });
    expect(prisma.card.create).not.toHaveBeenCalled();
  });

  it("returns notPending when the request is decided concurrently", async () => {
    prisma.cardEnrollmentRequest.updateMany.mockResolvedValue({ count: 0 });

    expect(await acceptCardEnrollmentRequest(args)).toEqual({ error: "notPending" });
  });
});

describe("rejectCardEnrollmentRequest", () => {
  const args = { requestId: "r1", issuerFundId: issuerFund.id, decidedById: "user-2" };

  it("only rejects a PENDING request of the issuer fund", async () => {
    prisma.cardEnrollmentRequest.updateMany.mockResolvedValue({ count: 1 });

    expect(await rejectCardEnrollmentRequest(args)).toEqual({ ok: true });
    const call = prisma.cardEnrollmentRequest.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "r1", issuerFundId: issuerFund.id, status: "PENDING" });
    expect(call.data).toMatchObject({ status: "REJECTED", decidedById: "user-2" });
  });

  it("tells notFound (other fund) from notPending (already decided)", async () => {
    prisma.cardEnrollmentRequest.updateMany.mockResolvedValue({ count: 0 });

    prisma.cardEnrollmentRequest.findFirst.mockResolvedValueOnce(null);
    expect(await rejectCardEnrollmentRequest(args)).toEqual({ error: "notFound" });

    prisma.cardEnrollmentRequest.findFirst.mockResolvedValueOnce({ id: "r1" });
    expect(await rejectCardEnrollmentRequest(args)).toEqual({ error: "notPending" });
    expect(prisma.cardEnrollmentRequest.findFirst.mock.calls[0][0].where).toEqual({
      id: "r1",
      issuerFundId: issuerFund.id,
    });
  });
});

describe("cancelCardEnrollmentRequest", () => {
  const args = { requestId: "r1", requesterFundId: requesterFund.id };

  it("only cancels a PENDING request of the requester fund", async () => {
    prisma.cardEnrollmentRequest.updateMany.mockResolvedValue({ count: 1 });

    expect(await cancelCardEnrollmentRequest(args)).toEqual({ ok: true });
    const call = prisma.cardEnrollmentRequest.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      id: "r1",
      requesterFundId: requesterFund.id,
      status: "PENDING",
    });
    expect(call.data).toMatchObject({ status: "CANCELLED" });
  });

  it("returns notFound / notPending when nothing was cancelled", async () => {
    prisma.cardEnrollmentRequest.updateMany.mockResolvedValue({ count: 0 });

    prisma.cardEnrollmentRequest.findFirst.mockResolvedValueOnce(null);
    expect(await cancelCardEnrollmentRequest(args)).toEqual({ error: "notFound" });

    prisma.cardEnrollmentRequest.findFirst.mockResolvedValueOnce({ id: "r1" });
    expect(await cancelCardEnrollmentRequest(args)).toEqual({ error: "notPending" });
  });
});

describe("listIncomingRequests", () => {
  it("lists pending first, then decided newest first", async () => {
    const base = {
      requestedNumber: null,
      holderName: null,
      enrolledCardId: null,
      card: { id: "card-issuer", serialNumber: "04AABB", number: 3 },
      issuerFund,
      requesterFund,
      member: null,
    };
    prisma.cardEnrollmentRequest.findMany.mockResolvedValue([
      { ...base, id: "dec-old", status: "REJECTED", createdAt: new Date("2026-10-10"), decidedAt: new Date("2026-10-11") },
      { ...base, id: "pend", status: "PENDING", createdAt: new Date("2026-10-01"), decidedAt: null },
      { ...base, id: "dec-new", status: "ACCEPTED", createdAt: new Date("2026-10-02"), decidedAt: new Date("2026-10-20") },
    ]);

    const items = await listIncomingRequests(issuerFund.id);

    expect(items.map((i) => i.id)).toEqual(["pend", "dec-new", "dec-old"]);
    expect(items[0]).toMatchObject({ serialNumber: "04AABB", cardId: "card-issuer", cardNumber: 3 });
    const where = prisma.cardEnrollmentRequest.findMany.mock.calls[0][0].where;
    expect(where.issuerFundId).toBe(issuerFund.id);
    expect(where.OR[0]).toEqual({ status: "PENDING" });
  });
});
