// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// computeCardSyncPlan: a CP-listed serial with no local row is imported —
// unless another fund issued it and this fund holds no ACCEPTED enrollment
// request for it. Then it goes to `requestEnrollment` (no request yet: the
// run asks the issuer instead of creating a row) or to `awaitingIssuer` (a
// request is already on file: shown, never re-filed).
vi.mock("server-only", () => ({}));

const enrollment = vi.hoisted(() => ({ findForeignCards: vi.fn() }));
vi.mock("@/services/card/enrollment-requests", () => enrollment);

const cp = vi.hoisted(() => ({ listCitizenPayCards: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

const prisma = vi.hoisted(() => ({
  card: { findMany: vi.fn(), update: vi.fn() },
  cardEvent: { create: vi.fn() },
  fundTokenAccount: { findMany: vi.fn() },
  cardEnrollmentRequest: { findMany: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { computeCardSyncPlan, findSerialsAwaitingIssuerAcceptance } from "./sync";

const fund = { id: "fund-1", citizenPayApiKeyId: "0xkey", citizenPayApiKeyEnc: "v1:enc" };

const foreignCard = {
  id: "card-x",
  fundId: "fund-2",
  serialNumber: "FOREIGN1",
  fund: { id: "fund-2", name: "Other Fund", domain: "other.lacaisse.eu" },
};

function remote(serialNumber: string) {
  return {
    serialNumber,
    status: "INACTIVE" as const,
    owner: null,
    sourceSerial: null,
    pinBlockedAt: null,
    createdAt: "2026-10-21T00:00:00Z",
    lastActivity: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.card.findMany.mockResolvedValue([]);
  prisma.fundTokenAccount.findMany.mockResolvedValue([]);
  prisma.cardEnrollmentRequest.findMany.mockResolvedValue([]);
  enrollment.findForeignCards.mockResolvedValue(new Map());
  cp.listCitizenPayCards.mockResolvedValue({
    cards: [],
    pagination: { page: 1, limit: 100, total: 0, totalPages: 1 },
  });
});

describe("findSerialsAwaitingIssuerAcceptance", () => {
  it("returns nothing without a foreign owner, and never queries requests", async () => {
    const out = await findSerialsAwaitingIssuerAcceptance("fund-1", ["NEW1"]);
    expect(out.size).toBe(0);
    expect(enrollment.findForeignCards).toHaveBeenCalledWith("fund-1", ["NEW1"]);
    expect(prisma.cardEnrollmentRequest.findMany).not.toHaveBeenCalled();
  });

  it("keeps a foreign serial with no request, carrying its status as null", async () => {
    enrollment.findForeignCards.mockResolvedValue(new Map([["FOREIGN1", foreignCard]]));

    const out = await findSerialsAwaitingIssuerAcceptance("fund-1", ["foreign1"]);

    expect(out.get("FOREIGN1")).toEqual({ card: foreignCard, requestStatus: null });
    expect(prisma.cardEnrollmentRequest.findMany).toHaveBeenCalledWith({
      where: { requesterFundId: "fund-1", cardId: { in: ["card-x"] } },
      select: { cardId: true, status: true },
    });
  });

  it("drops a foreign serial this fund already has an ACCEPTED request for", async () => {
    enrollment.findForeignCards.mockResolvedValue(new Map([["FOREIGN1", foreignCard]]));
    prisma.cardEnrollmentRequest.findMany.mockResolvedValue([
      { cardId: "card-x", status: "ACCEPTED" },
    ]);

    const out = await findSerialsAwaitingIssuerAcceptance("fund-1", ["FOREIGN1"]);
    expect(out.size).toBe(0);
  });

  it.each(["PENDING", "REJECTED", "CANCELLED"] as const)(
    "keeps a foreign serial whose request is %s",
    async (status) => {
      enrollment.findForeignCards.mockResolvedValue(new Map([["FOREIGN1", foreignCard]]));
      prisma.cardEnrollmentRequest.findMany.mockResolvedValue([{ cardId: "card-x", status }]);

      const out = await findSerialsAwaitingIssuerAcceptance("fund-1", ["FOREIGN1"]);
      expect(out.get("FOREIGN1")).toEqual({ card: foreignCard, requestStatus: status });
    },
  );
});

describe("computeCardSyncPlan — serials issued by another fund", () => {
  it("imports a CP-only serial nobody else holds", async () => {
    cp.listCitizenPayCards.mockResolvedValue({
      cards: [remote("NEW1")],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const plan = await computeCardSyncPlan(fund);

    expect(plan.import.map((i) => i.serialNumber)).toEqual(["NEW1"]);
    expect(plan.requestEnrollment).toEqual([]);
    expect(plan.awaitingIssuer).toEqual([]);
    expect(enrollment.findForeignCards).toHaveBeenCalledWith("fund-1", ["NEW1"]);
  });

  it("routes a foreign serial this fund never asked for to requestEnrollment", async () => {
    cp.listCitizenPayCards.mockResolvedValue({
      cards: [remote("foreign1"), remote("NEW1")],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });
    enrollment.findForeignCards.mockResolvedValue(new Map([["FOREIGN1", foreignCard]]));

    const plan = await computeCardSyncPlan(fund);

    expect(plan.import.map((i) => i.serialNumber)).toEqual(["NEW1"]);
    expect(plan.requestEnrollment).toEqual([{ serialNumber: "foreign1", card: foreignCard }]);
    expect(plan.awaitingIssuer).toEqual([]);
  });

  it.each(["PENDING", "REJECTED", "CANCELLED"] as const)(
    "lists a foreign serial with a %s request under awaitingIssuer, not requestEnrollment",
    async (status) => {
      cp.listCitizenPayCards.mockResolvedValue({
        cards: [remote("foreign1")],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      });
      enrollment.findForeignCards.mockResolvedValue(new Map([["FOREIGN1", foreignCard]]));
      prisma.cardEnrollmentRequest.findMany.mockResolvedValue([{ cardId: "card-x", status }]);

      const plan = await computeCardSyncPlan(fund);

      expect(plan.import).toEqual([]);
      expect(plan.requestEnrollment).toEqual([]);
      expect(plan.awaitingIssuer).toEqual([
        { serialNumber: "foreign1", card: foreignCard, requestStatus: status },
      ]);
    },
  );

  it("splits foreign serials between the two buckets by request state", async () => {
    const foreignCard2 = { ...foreignCard, id: "card-y", serialNumber: "FOREIGN2" };
    cp.listCitizenPayCards.mockResolvedValue({
      cards: [remote("FOREIGN1"), remote("FOREIGN2")],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });
    enrollment.findForeignCards.mockResolvedValue(
      new Map([
        ["FOREIGN1", foreignCard],
        ["FOREIGN2", foreignCard2],
      ]),
    );
    prisma.cardEnrollmentRequest.findMany.mockResolvedValue([
      { cardId: "card-y", status: "REJECTED" },
    ]);

    const plan = await computeCardSyncPlan(fund);

    expect(plan.requestEnrollment).toEqual([{ serialNumber: "FOREIGN1", card: foreignCard }]);
    expect(plan.awaitingIssuer).toEqual([
      { serialNumber: "FOREIGN2", card: foreignCard2, requestStatus: "REJECTED" },
    ]);
  });

  it("imports a foreign serial once the issuer accepted this fund's request", async () => {
    cp.listCitizenPayCards.mockResolvedValue({
      cards: [remote("FOREIGN1")],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });
    enrollment.findForeignCards.mockResolvedValue(new Map([["FOREIGN1", foreignCard]]));
    prisma.cardEnrollmentRequest.findMany.mockResolvedValue([
      { cardId: "card-x", status: "ACCEPTED" },
    ]);

    const plan = await computeCardSyncPlan(fund);

    expect(plan.import.map((i) => i.serialNumber)).toEqual(["FOREIGN1"]);
    expect(plan.requestEnrollment).toEqual([]);
    expect(plan.awaitingIssuer).toEqual([]);
  });

  it("leaves local rows and source accounts out of the foreign check", async () => {
    cp.listCitizenPayCards.mockResolvedValue({
      cards: [remote("LOCAL1"), remote("SRC1"), remote("NEW1")],
      pagination: { page: 1, limit: 100, total: 3, totalPages: 1 },
    });
    prisma.card.findMany.mockResolvedValue([
      {
        id: "c1",
        serialNumber: "local1",
        status: "INACTIVE",
        account: null,
        holderName: null,
        sourceSerial: null,
        member: null,
      },
    ]);
    prisma.fundTokenAccount.findMany.mockResolvedValue([{ serial: "src1" }]);

    const plan = await computeCardSyncPlan(fund);

    expect(enrollment.findForeignCards).toHaveBeenCalledWith("fund-1", ["NEW1"]);
    expect(plan.import.map((i) => i.serialNumber)).toEqual(["NEW1"]);
    expect(plan.push).toEqual([]);
  });
});

// The status rule (services/card/pin-block-rules.ts) in the plan: local is
// authoritative and pushed on a mismatch, except a PIN block, which is the
// api's — applied while computing the plan, like the source-serial heal, and
// reported under `pinBlockSync`, never queued as a push.
describe("computeCardSyncPlan — PIN blocks belong to the api", () => {
  const blockedAtIso = "2026-11-03T09:12:00.000Z";
  const localCard = (over: Record<string, unknown>) => ({
    id: "card-1",
    serialNumber: "SER1",
    status: "ACTIVE",
    blockedReason: null,
    blockedAt: null,
    account: null,
    holderName: null,
    sourceSerial: null,
    member: null,
    ...over,
  });
  const listed = (over: Record<string, unknown>) => {
    cp.listCitizenPayCards.mockResolvedValue({
      cards: [{ ...remote("SER1"), ...over }],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });
  };

  it("imports a PIN block the api reports instead of pushing ACTIVE over it", async () => {
    prisma.card.findMany.mockResolvedValue([localCard({ status: "ACTIVE" })]);
    listed({ status: "BLOCKED", pinBlockedAt: blockedAtIso });

    const plan = await computeCardSyncPlan(fund);

    expect(plan.statusUpdate).toEqual([]);
    expect(plan.pinBlockSync).toEqual([
      { cardId: "card-1", serialNumber: "SER1", kind: "pin_block" },
    ]);
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: {
        status: "BLOCKED",
        blockedReason: "PIN",
        blockedAt: new Date(blockedAtIso),
      },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fundId: "fund-1",
        cardId: "card-1",
        kind: "PIN_BLOCKED",
        source: "SYNC",
        at: new Date(blockedAtIso),
      }),
    });
  });

  it("leaves a PIN block already on file alone", async () => {
    prisma.card.findMany.mockResolvedValue([
      localCard({ status: "BLOCKED", blockedReason: "PIN", blockedAt: new Date(blockedAtIso) }),
    ]);
    listed({ status: "BLOCKED", pinBlockedAt: blockedAtIso });

    const plan = await computeCardSyncPlan(fund);

    expect(plan.statusUpdate).toEqual([]);
    expect(plan.pinBlockSync).toEqual([]);
    expect(prisma.card.update).not.toHaveBeenCalled();
  });

  it("pulls a PIN-blocked local row back to ACTIVE when the api is active", async () => {
    prisma.card.findMany.mockResolvedValue([
      localCard({ status: "BLOCKED", blockedReason: "PIN", blockedAt: new Date(blockedAtIso) }),
    ]);
    listed({ status: "ACTIVE", pinBlockedAt: null });

    const plan = await computeCardSyncPlan(fund);

    expect(plan.statusUpdate).toEqual([]);
    expect(plan.pinBlockSync).toEqual([
      { cardId: "card-1", serialNumber: "SER1", kind: "pin_release" },
    ]);
    expect(prisma.card.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { status: "ACTIVE", blockedReason: null, blockedAt: null },
    });
    expect(prisma.cardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "PIN_UNBLOCKED", source: "SYNC" }),
    });
  });

  it("still pushes a fund block (reason FUND, and a legacy row without a reason)", async () => {
    prisma.card.findMany.mockResolvedValue([
      localCard({ status: "BLOCKED", blockedReason: "FUND", blockedAt: new Date() }),
      localCard({ id: "card-2", serialNumber: "SER2", status: "BLOCKED", blockedReason: null, blockedAt: new Date() }),
    ]);
    cp.listCitizenPayCards.mockResolvedValue({
      cards: [
        { ...remote("SER1"), status: "ACTIVE" },
        { ...remote("SER2"), status: "BLOCKED", pinBlockedAt: blockedAtIso },
      ],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });

    const plan = await computeCardSyncPlan(fund);

    expect(plan.statusUpdate).toEqual([
      { cardId: "card-1", serialNumber: "SER1", localStatus: "BLOCKED", remoteStatus: "ACTIVE" },
    ]);
    expect(plan.pinBlockSync).toEqual([]);
    expect(prisma.card.update).not.toHaveBeenCalled();
  });

  it("pushes an ordinary mismatch as before", async () => {
    prisma.card.findMany.mockResolvedValue([localCard({ status: "INACTIVE" })]);
    listed({ status: "ACTIVE", pinBlockedAt: null });

    const plan = await computeCardSyncPlan(fund);

    expect(plan.statusUpdate).toEqual([
      { cardId: "card-1", serialNumber: "SER1", localStatus: "INACTIVE", remoteStatus: "ACTIVE" },
    ]);
    expect(plan.pinBlockSync).toEqual([]);
  });
});
