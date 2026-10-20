// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Wiring: the member CSV import schedules the CitizenPay holder-name publish
// for newly linked cards and for a renamed member's restamped cards, and
// leaves an already-held card's own holderName alone on re-import.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const fund = vi.hoisted(() => ({
  id: "fund-1",
  allocationMode: "OPEN",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({ fund }),
}));

const publish = vi.hoisted(() => ({
  scheduleCardHolderNamePublish: vi.fn(),
  renameStampedHolderNames: vi.fn(),
}));
vi.mock("@/services/card/publish-holder-name", () => publish);

const prisma = vi.hoisted(() => {
  const p = {
    member: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    card: { findFirst: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  };
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p));
  return p;
});
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { importMembersAction } from "./import-actions";

const mapping = {
  firstName: "first",
  lastName: "last",
  email: "email",
  serial: "serial",
};
const csv = (row: string) => `first,last,email,serial\n${row}\n`;

beforeEach(() => {
  vi.clearAllMocks();
  publish.renameStampedHolderNames.mockResolvedValue([]);
});

describe("importMembersAction holder-name publish", () => {
  it("publishes a card newly linked to a created member", async () => {
    prisma.member.findUnique.mockResolvedValue(null);
    prisma.member.create.mockResolvedValue({ id: "m-new" });
    prisma.card.findFirst.mockResolvedValue({ id: "card-1", memberId: null });

    const res = await importMembersAction({ csv: csv("Jane,Doe,jane@example.org,S1"), mapping });
    expect(res).toMatchObject({ ok: true, created: 1, cardsLinked: 1 });
    expect(prisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memberId: "m-new", holderName: "Jane Doe" }),
      }),
    );
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, ["card-1"]);
  });

  it("restamps and publishes a renamed member's cards", async () => {
    prisma.member.findUnique.mockResolvedValue({
      id: "m1",
      firstName: "Jane",
      lastName: "Doe",
      applicationData: null,
    });
    publish.renameStampedHolderNames.mockResolvedValue(["card-1"]);

    const res = await importMembersAction({ csv: csv("Jane,Smith,jane@example.org,"), mapping });
    expect(res).toMatchObject({ ok: true, updated: 1 });
    expect(publish.renameStampedHolderNames).toHaveBeenCalledWith({
      fundId: "fund-1",
      memberId: "m1",
      oldName: "Jane Doe",
      newName: "Jane Smith",
    });
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, ["card-1"]);
  });

  it("keeps an already-held card's holderName on re-import and doesn't republish it", async () => {
    prisma.member.findUnique.mockResolvedValue({
      id: "m1",
      firstName: "Jane",
      lastName: "Doe",
      applicationData: null,
    });
    prisma.card.findFirst.mockResolvedValue({ id: "card-kid", memberId: "m1" });

    await importMembersAction({ csv: csv("Jane,Doe,jane@example.org,S2"), mapping });
    const data = prisma.card.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ memberId: "m1" });
    expect(data).not.toHaveProperty("holderName");
    expect(publish.scheduleCardHolderNamePublish).toHaveBeenCalledWith(fund, []);
  });
});
