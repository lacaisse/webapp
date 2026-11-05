// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins the subscription acceptance: one conditional write with normalised
// billing values, emails deferred to after() (and only for the write that won),
// validation failures write nothing.
vi.mock("server-only", () => ({}));
const { afterCallbacks, fundUpdateMany, fundFindUnique, sendSubscriptionEmails } = vi.hoisted(
  () => ({
    afterCallbacks: [] as Array<() => Promise<void>>,
    fundUpdateMany: vi.fn(),
    fundFindUnique: vi.fn(),
    sendSubscriptionEmails: vi.fn(async () => {}),
  }),
);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({
    user: { id: "user-1", email: "owner@example.org" },
    fund: {
      id: "fund-1",
      name: "La Class",
      domain: "laclass.lacaisse.eu",
      defaultLocale: "fr",
      primaryColor: null,
      logoUrl: null,
      citizenPayFundId: "treasury-1",
      citizenPayBusinessId: null,
      subscriptionAcceptedAt: null,
    },
    membership: { role: "OWNER" },
  }),
}));
vi.mock("@/services/db/prisma", () => ({
  prisma: { fund: { updateMany: fundUpdateMany, findUnique: fundFindUnique } },
}));
vi.mock("./emails", () => ({ sendSubscriptionEmails }));

import { acceptSubscriptionAction } from "./admin-actions";

const input = {
  legalName: "  La Class ASBL ",
  email: "Billing@LaClass.be",
  address: "Rue de la Loi 1\n1000 Bruxelles",
  vatNumber: "",
  accepted: true as const,
};

beforeEach(() => {
  afterCallbacks.length = 0;
  fundUpdateMany.mockReset();
  fundFindUnique.mockReset();
  sendSubscriptionEmails.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acceptSubscriptionAction", () => {
  it("records the acceptance once with normalised values and schedules the emails", async () => {
    fundUpdateMany.mockResolvedValue({ count: 1 });

    const result = await acceptSubscriptionAction(input);
    expect(result).toEqual({ ok: true, acceptedAt: expect.any(String), alreadyAccepted: false });

    expect(fundUpdateMany).toHaveBeenCalledOnce();
    const [args] = fundUpdateMany.mock.calls[0];
    expect(args.where).toEqual({ id: "fund-1", subscriptionAcceptedAt: null });
    expect(args.data).toEqual({
      subscriptionAcceptedAt: expect.any(Date),
      subscriptionAcceptedByUserId: "user-1",
      billingLegalName: "La Class ASBL",
      billingEmail: "billing@laclass.be",
      billingAddress: "Rue de la Loi 1\n1000 Bruxelles",
      billingVatNumber: null,
    });

    expect(sendSubscriptionEmails).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(sendSubscriptionEmails).toHaveBeenCalledOnce();
    expect(sendSubscriptionEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedByEmail: "owner@example.org",
        billing: {
          legalName: "La Class ASBL",
          email: "billing@laclass.be",
          address: "Rue de la Loi 1\n1000 Bruxelles",
          vatNumber: null,
        },
      }),
    );
  });

  it("refuses without the agreement and writes nothing", async () => {
    const result = await acceptSubscriptionAction({
      ...input,
      accepted: false as unknown as true,
    });
    expect(result).toEqual({
      error: "fund.settings.subscription.errors.mustAccept",
      field: "accepted",
    });
    expect(fundUpdateMany).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
  });

  it("returns the existing acceptance when another submit already won", async () => {
    const existing = new Date("2026-10-01T09:30:00.000Z");
    fundUpdateMany.mockResolvedValue({ count: 0 });
    fundFindUnique.mockResolvedValue({ subscriptionAcceptedAt: existing });

    const result = await acceptSubscriptionAction({ ...input, vatNumber: "be 0123.456.789" });
    expect(result).toEqual({
      ok: true,
      acceptedAt: existing.toISOString(),
      alreadyAccepted: true,
    });
    expect(fundFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "fund-1" } }),
    );
    expect(afterCallbacks).toHaveLength(0);
    expect(sendSubscriptionEmails).not.toHaveBeenCalled();
  });
});
