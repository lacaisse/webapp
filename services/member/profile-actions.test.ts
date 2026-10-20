// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// updateMemberProfileAction's rename path: the Card.holderName rewrite and the
// deferred CitizenPay publish. Cards live in a tiny in-memory table; the real
// publish module runs against the in-process mock CitizenPay client.
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

const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));

type CardRow = {
  id: string;
  fundId: string;
  serialNumber: string;
  memberId: string | null;
  holderName: string | null;
};
const db = vi.hoisted(() => ({
  member: { id: "m1", firstName: "Jane", lastName: "Doe" },
  cards: [] as CardRow[],
}));

// Just enough of Prisma's where semantics for the queries under test.
function matches(c: CardRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") {
      return (v as Record<string, unknown>[]).some((w) => matches(c, w));
    }
    if (v && typeof v === "object" && "in" in v) {
      return (v as { in: unknown[] }).in.includes(c[k as keyof CardRow]);
    }
    return c[k as keyof CardRow] === v;
  });
}

const prisma = vi.hoisted(() => ({
  member: { findFirst: vi.fn(), update: vi.fn() },
  allocationTier: { count: vi.fn() },
  card: { findMany: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { getCitizenPayClient } from "@/services/citizenpay/client";
import { updateMemberProfileAction } from "./profile-actions";

type MockProto = {
  setCardHolderName: (serial: string, name: string | null) => Promise<void>;
};
let setName: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const proto = Object.getPrototypeOf(getCitizenPayClient(fund)) as MockProto;
  setName = vi.spyOn(proto, "setCardHolderName");
  afterCallbacks.length = 0;
  db.member = { id: "m1", firstName: "Jane", lastName: "Doe" };
  db.cards = [
    { id: "c-primary", fundId: "fund-1", serialNumber: "S1", memberId: "m1", holderName: "Jane Doe" },
    { id: "c-kid", fundId: "fund-1", serialNumber: "S2", memberId: "m1", holderName: "Tom Doe" },
    { id: "c-other", fundId: "fund-1", serialNumber: "S3", memberId: "m2", holderName: "Jane Doe" },
  ];

  prisma.member.findFirst.mockImplementation(async () => ({ ...db.member, tier: null }));
  prisma.member.update.mockImplementation(async ({ data }: { data: typeof db.member }) => {
    db.member = { ...db.member, firstName: data.firstName, lastName: data.lastName };
  });
  prisma.allocationTier.count.mockResolvedValue(0);
  prisma.card.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    db.cards.filter((c) => matches(c, where)).map((c) => ({ ...c })),
  );
  prisma.card.updateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Partial<CardRow> }) => {
      const hit = db.cards.filter((c) => matches(c, where));
      for (const c of hit) Object.assign(c, data);
      return { count: hit.length };
    },
  );
  prisma.card.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const c = db.cards.find((x) => x.id === where.id);
    return c ? { ...c, member: { firstName: db.member.firstName, lastName: db.member.lastName } } : null;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const edit = (firstName: string, lastName: string) =>
  updateMemberProfileAction({
    memberId: "m1",
    firstName,
    lastName,
    email: "jane@example.org",
  });

const holder = (id: string) => db.cards.find((c) => c.id === id)!.holderName;

describe("updateMemberProfileAction rename", () => {
  it("rewrites the card stamped with the exact old name, leaves the dependant's card alone", async () => {
    expect(await edit("Jane", "Smith")).toEqual({ ok: true });
    expect(holder("c-primary")).toBe("Jane Smith");
    expect(holder("c-kid")).toBe("Tom Doe");
    expect(holder("c-other")).toBe("Jane Doe"); // another member's card
  });

  it("publishes only the rewritten card, after the response", async () => {
    await edit("Jane", "Smith");
    expect(setName).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(setName.mock.calls).toEqual([["S1", "Jane Smith"]]);
  });

  it("schedules nothing when the name is unchanged", async () => {
    await edit("Jane", "Doe");
    expect(prisma.card.updateMany).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
  });

  it("still returns ok when the publish fails", async () => {
    setName.mockRejectedValue(new TypeError("fetch failed"));
    expect(await edit("Jane", "Smith")).toEqual({ ok: true });
    await expect(afterCallbacks[0]()).resolves.toBeUndefined();
    expect(holder("c-primary")).toBe("Jane Smith");
  });
});
