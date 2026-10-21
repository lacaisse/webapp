// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /cards → Sync run path: a CP-listed serial another fund issued never
// gets a local row — `importOneCardAction` re-checks the issuer rule itself
// (a stale plan can't bypass it) and `requestOneCardEnrollmentAction` files
// the CardEnrollmentRequest. services/card/sync.test.ts covers the plan.
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

const numbering = vi.hoisted(() => ({ nextCardNumber: vi.fn() }));
vi.mock("@/services/card/numbering", () => numbering);
vi.mock("@/services/card/publish-holder-name", () => ({
  scheduleCardHolderNamePublish: vi.fn(),
}));
const cp = vi.hoisted(() => ({ getCitizenPayCard: vi.fn() }));
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

const sync = vi.hoisted(() => ({
  computeCardSyncPlan: vi.fn(),
  findSerialsAwaitingIssuerAcceptance: vi.fn(),
}));
vi.mock("./sync", () => sync);

const prisma = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import {
  importOneCardAction,
  previewCardSyncAction,
  requestOneCardEnrollmentAction,
} from "./admin-actions";

const foreignCard = {
  id: "card-x",
  fundId: "fund-2",
  serialNumber: "FOREIGN1",
  fund: { id: "fund-2", name: "Other Fund", domain: "other.lacaisse.eu" },
};

const expectedRequest = {
  requesterFund: { id: "fund-1", name: "Fund", domain: "fund.lacaisse.eu" },
  requestedById: "u1",
  card: foreignCard,
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.card.findFirst.mockResolvedValue(null);
  prisma.card.create.mockResolvedValue({ id: "card-new" });
  numbering.nextCardNumber.mockResolvedValue(7);
  sync.findSerialsAwaitingIssuerAcceptance.mockResolvedValue(new Map());
  enrollment.requestCardEnrollment.mockResolvedValue({ id: "req-1", status: "PENDING" });
  cp.getCitizenPayCard.mockResolvedValue({
    serialNumber: "NEW1",
    account: "0xabc",
    status: "INACTIVE",
    sourceSerial: null,
    createdAt: "2026-10-21T00:00:00Z",
  });
});

describe("importOneCardAction — issuer rule", () => {
  it("imports a serial no other fund holds", async () => {
    const res = await importOneCardAction({ serialNumber: "NEW1" });

    expect(res).toEqual({ ok: true });
    expect(sync.findSerialsAwaitingIssuerAcceptance).toHaveBeenCalledWith("fund-1", ["NEW1"]);
    expect(prisma.card.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fundId: "fund-1", serialNumber: "NEW1" }),
      }),
    );
    expect(enrollment.requestCardEnrollment).not.toHaveBeenCalled();
  });

  it("files a request instead of a row for a serial another fund issued", async () => {
    sync.findSerialsAwaitingIssuerAcceptance.mockResolvedValue(
      new Map([["FOREIGN1", { card: foreignCard, requestStatus: null }]]),
    );

    const res = await importOneCardAction({ serialNumber: "foreign1" });

    expect(res).toEqual({ ok: true });
    expect(enrollment.requestCardEnrollment).toHaveBeenCalledWith(expectedRequest);
    expect(cp.getCitizenPayCard).not.toHaveBeenCalled();
    expect(prisma.card.create).not.toHaveBeenCalled();
  });

  it("does nothing when the fund already holds the serial", async () => {
    prisma.card.findFirst.mockResolvedValue({ id: "card-own" });

    const res = await importOneCardAction({ serialNumber: "FOREIGN1" });

    expect(res).toEqual({ ok: true });
    expect(sync.findSerialsAwaitingIssuerAcceptance).not.toHaveBeenCalled();
    expect(prisma.card.create).not.toHaveBeenCalled();
  });
});

describe("requestOneCardEnrollmentAction", () => {
  it("files the request with the issuer's card", async () => {
    sync.findSerialsAwaitingIssuerAcceptance.mockResolvedValue(
      new Map([["FOREIGN1", { card: foreignCard, requestStatus: "REJECTED" }]]),
    );

    const res = await requestOneCardEnrollmentAction({ serialNumber: "FOREIGN1" });

    expect(res).toEqual({ ok: true });
    expect(enrollment.requestCardEnrollment).toHaveBeenCalledWith(expectedRequest);
    expect(prisma.card.create).not.toHaveBeenCalled();
  });

  it("leaves a PENDING request untouched", async () => {
    sync.findSerialsAwaitingIssuerAcceptance.mockResolvedValue(
      new Map([["FOREIGN1", { card: foreignCard, requestStatus: "PENDING" }]]),
    );

    const res = await requestOneCardEnrollmentAction({ serialNumber: "FOREIGN1" });

    expect(res).toEqual({ ok: true });
    expect(enrollment.requestCardEnrollment).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing awaits acceptance any more (accepted since preview)", async () => {
    const res = await requestOneCardEnrollmentAction({ serialNumber: "FOREIGN1" });

    expect(res).toEqual({ ok: true });
    expect(enrollment.requestCardEnrollment).not.toHaveBeenCalled();
    expect(prisma.card.create).not.toHaveBeenCalled();
  });

  it("reports the serial when the request fails", async () => {
    sync.findSerialsAwaitingIssuerAcceptance.mockResolvedValue(
      new Map([["FOREIGN1", { card: foreignCard, requestStatus: null }]]),
    );
    enrollment.requestCardEnrollment.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await requestOneCardEnrollmentAction({ serialNumber: "FOREIGN1" });

    expect(res).toEqual({ error: "FOREIGN1" });
    spy.mockRestore();
  });
});

describe("previewCardSyncAction", () => {
  it("sends the request bucket to the dialog with the issuer's name", async () => {
    sync.computeCardSyncPlan.mockResolvedValue({
      push: [],
      import: [{ serialNumber: "NEW1", status: "INACTIVE", account: null, createdAt: "" }],
      requestEnrollment: [
        { serialNumber: "FOREIGN1", card: foreignCard, requestStatus: null },
      ],
      statusUpdate: [],
    });

    const res = await previewCardSyncAction();

    expect(res).toEqual({
      ok: true,
      plan: {
        import: [{ serialNumber: "NEW1" }],
        requestEnrollment: [{ serialNumber: "FOREIGN1", issuerFundName: "Other Fund" }],
        statusUpdate: [],
        push: [],
      },
    });
  });
});
