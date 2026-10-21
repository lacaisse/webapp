// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// importCardNumbersAction: serials issued by ANOTHER fund are routed into a
// CardEnrollmentRequest instead of being provisioned at CitizenPay / created
// locally. services/card/enrollment-requests.test.ts covers the request itself.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const fund = vi.hoisted(() => ({
  id: "fund-1",
  name: "Fund",
  domain: "fund.lacaisse.eu",
  citizenPayFundId: "cp-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({ fund, user: { id: "u1" } }),
}));

const enrollment = vi.hoisted(() => ({
  findForeignCards: vi.fn(),
  requestCardEnrollment: vi.fn(),
}));
vi.mock("@/services/card/enrollment-requests", () => enrollment);

vi.mock("@/services/card/publish-holder-name", () => ({
  scheduleCardHolderNamePublish: vi.fn(),
}));
const cp = vi.hoisted(() => ({
  bulkCreateCards: vi.fn(),
  getCitizenPayCard: vi.fn(),
}));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));
vi.mock("@/services/token/userop", () => ({
  burnFromToken: vi.fn(),
  mintToken: vi.fn(),
  UserOpError: class UserOpError extends Error {},
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({ ANNOTATION_TRIGGERS: {} }));
vi.mock("@/services/transaction-annotation/pending", () => ({
  resolveOrEnqueueAnnotation: vi.fn(),
}));
vi.mock("./sync", () => ({ computeCardSyncPlan: vi.fn() }));

const prisma = vi.hoisted(() => ({
  card: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { importCardNumbersAction } from "./admin-actions";

const foreignCard = {
  id: "card-x",
  fundId: "fund-2",
  serialNumber: "FOREIGN1",
  fund: { id: "fund-2", name: "Other Fund", domain: "other.lacaisse.eu" },
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.card.findMany.mockResolvedValue([]);
  prisma.card.count.mockResolvedValue(0);
  enrollment.findForeignCards.mockResolvedValue(new Map());
  enrollment.requestCardEnrollment.mockResolvedValue({ id: "req-1", status: "PENDING" });
  cp.bulkCreateCards.mockResolvedValue(undefined);
  cp.getCitizenPayCard.mockResolvedValue({ account: "0xabc", status: "INACTIVE" });
});

describe("importCardNumbersAction — cross-fund serials", () => {
  it("files a request for a foreign serial and provisions only the rest", async () => {
    prisma.card.findMany.mockResolvedValue([{ id: "card-own", serialNumber: "own1" }]);
    enrollment.findForeignCards.mockResolvedValue(new Map([["FOREIGN1", foreignCard]]));
    prisma.card.create.mockResolvedValue({ id: "card-new" });

    const res = await importCardNumbersAction({
      csv: "serial,number\nOWN1,1\nforeign1,2\nNEW1,3\n",
      serialColumn: "serial",
      numberColumn: "number",
    });

    expect(res).toEqual({
      ok: true,
      applied: 2,
      provisioned: 1,
      displaced: 0,
      skipped: [],
      requested: [{ serial: "FOREIGN1", fundName: "Other Fund" }],
    });
    expect(enrollment.findForeignCards).toHaveBeenCalledWith("fund-1", ["FOREIGN1", "NEW1"]);
    expect(enrollment.requestCardEnrollment).toHaveBeenCalledWith({
      requesterFund: { id: "fund-1", name: "Fund", domain: "fund.lacaisse.eu" },
      requestedById: "u1",
      card: foreignCard,
      requestedNumber: 2,
    });
    expect(cp.bulkCreateCards).toHaveBeenCalledWith(["NEW1"]);
    expect(prisma.card.create).toHaveBeenCalledTimes(1);
    expect(prisma.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ serialNumber: "NEW1" }) }),
    );
  });

  it("reports requests (not noMatches) when the only serial is foreign", async () => {
    enrollment.findForeignCards.mockResolvedValue(new Map([["FOREIGN1", foreignCard]]));

    const res = await importCardNumbersAction({
      csv: "serial,number\nFOREIGN1,5\n",
      serialColumn: "serial",
      numberColumn: "number",
    });

    expect(res).toEqual({
      ok: true,
      applied: 0,
      provisioned: 0,
      displaced: 0,
      skipped: [],
      requested: [{ serial: "FOREIGN1", fundName: "Other Fund" }],
    });
    expect(enrollment.requestCardEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({ card: foreignCard, requestedNumber: 5 }),
    );
    expect(cp.bulkCreateCards).not.toHaveBeenCalled();
    expect(prisma.card.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("skips a serial whose request fails without aborting the import", async () => {
    const other = { ...foreignCard, id: "card-y", serialNumber: "FOREIGN2" };
    enrollment.findForeignCards.mockResolvedValue(
      new Map([
        ["FOREIGN1", foreignCard],
        ["FOREIGN2", other],
      ]),
    );
    enrollment.requestCardEnrollment
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: "req-2", status: "PENDING" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await importCardNumbersAction({
      csv: "serial,number\nFOREIGN1,1\nFOREIGN2,2\n",
      serialColumn: "serial",
      numberColumn: "number",
    });

    expect(res).toEqual({
      ok: true,
      applied: 0,
      provisioned: 0,
      displaced: 0,
      skipped: ["FOREIGN1"],
      requested: [{ serial: "FOREIGN2", fundName: "Other Fund" }],
    });
    expect(err).toHaveBeenCalledWith(
      "[card.numberImport] request failed",
      "FOREIGN1",
      expect.any(Error),
    );
    expect(cp.bulkCreateCards).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("keeps noMatches when nothing applies and nothing was requested", async () => {
    prisma.card.create.mockRejectedValue(new Error("P2002"));
    prisma.card.findFirst.mockResolvedValue(null);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await importCardNumbersAction({
      csv: "serial,number\nNEW1,1\n",
      serialColumn: "serial",
      numberColumn: "number",
    });
    // bulkCreate succeeded but the local create failed and no row was found.
    expect(res).toEqual({ error: "cards.admin.numberImport.errors.noMatches" });
    expect(enrollment.requestCardEnrollment).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
