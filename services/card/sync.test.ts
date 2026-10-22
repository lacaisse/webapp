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
