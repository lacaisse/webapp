// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// publishCardHolderName against the in-process mock CitizenPay client (no
// CITIZENPAY_API_BASE_URL). The database and `after()` are faked.
vi.mock("server-only", () => ({}));

const prisma = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));

import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import {
  publishCardHolderName,
  publishCardHolderNames,
  renameStampedHolderNames,
  scheduleCardHolderNamePublish,
} from "./publish-holder-name";

const connected = {
  id: "fund-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
};
const unconnected = { id: "fund-2", citizenPayApiKeyId: null, citizenPayApiKeyEnc: null };

type MockProto = {
  setCardHolderName: (serial: string, name: string | null) => Promise<void>;
};
let setName: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

const assigned = (id: string, holderName: string | null = null) => ({
  serialNumber: `SER-${id}`,
  memberId: "m1",
  holderName,
  member: { firstName: "Jane", lastName: "Doe" },
});

beforeEach(() => {
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // The mock client is a fresh instance per getCitizenPayClient call; spy on
  // the shared prototype so every instance is observed.
  const proto = Object.getPrototypeOf(getCitizenPayClient(connected)) as MockProto;
  setName = vi.spyOn(proto, "setCardHolderName");
  prisma.card.findFirst.mockReset();
  prisma.card.findMany.mockReset();
  prisma.card.updateMany.mockReset();
  afterCallbacks.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("publishCardHolderName", () => {
  it("sets the holder's name for an assigned card", async () => {
    prisma.card.findFirst.mockResolvedValue(assigned("1"));
    expect(await publishCardHolderName(connected, "card-1")).toBe("ok");
    expect(prisma.card.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "card-1", fundId: "fund-1" } }),
    );
    expect(setName).toHaveBeenCalledWith("SER-1", "Jane Doe");
  });

  it("resets the name with null for an unassigned card", async () => {
    prisma.card.findFirst.mockResolvedValue({
      serialNumber: "ABC123",
      memberId: null,
      holderName: "Jane Doe", // stale, kept by unassignCardAction
      member: null,
    });
    await publishCardHolderName(connected, "card-1");
    expect(setName).toHaveBeenCalledWith("ABC123", null);
  });

  it("skips a fund not connected to CitizenPay", async () => {
    expect(await publishCardHolderName(unconnected, "card-1")).toBe("skipped");
    expect(prisma.card.findFirst).not.toHaveBeenCalled();
    expect(setName).not.toHaveBeenCalled();
  });

  it("does nothing for a card outside the fund", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    expect(await publishCardHolderName(connected, "card-x")).toBe("skipped");
    expect(setName).not.toHaveBeenCalled();
  });

  it("swallows a client error and logs only the status, once", async () => {
    prisma.card.findFirst.mockResolvedValue(assigned("1", "Jane Doe"));
    setName.mockRejectedValue(
      new CitizenPayApiError("no profile for Jane Doe", 404, { error: "Jane Doe" }),
    );
    expect(await publishCardHolderName(connected, "card-1")).toBe("404");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].map(String).join(" ");
    expect(line).toContain("404");
    expect(line).not.toContain("Jane");
    expect(line).not.toContain("SER-1");
  });

  it("classifies an unreachable CP as a network failure", async () => {
    prisma.card.findFirst.mockResolvedValue(assigned("1"));
    setName.mockRejectedValue(new TypeError("fetch failed"));
    expect(await publishCardHolderName(connected, "card-1")).toBe("network");
  });

  it("the mock client never logs the name", async () => {
    prisma.card.findFirst.mockResolvedValue(assigned("1", "Jane Doe"));
    await publishCardHolderName(connected, "card-1");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Jane");
  });
});

describe("publishCardHolderNames", () => {
  it("publishes each card once with bounded concurrency", async () => {
    prisma.card.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      assigned(where.id),
    );
    let inFlight = 0;
    let peak = 0;
    setName.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const summary = await publishCardHolderNames(connected, [...ids, "c0"], { concurrency: 4 });
    expect(summary).toEqual({ ok: 10, failed: 0, notAttempted: 0 });
    expect(setName).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps going past HTTP errors but stops after a network failure", async () => {
    prisma.card.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      assigned(where.id),
    );
    setName.mockImplementation(async (serial: string) => {
      if (serial === "SER-c0") throw new CitizenPayApiError("x", 404, null);
      if (serial === "SER-c1") throw new TypeError("fetch failed");
    });
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const summary = await publishCardHolderNames(connected, ids, { concurrency: 1 });
    expect(summary).toEqual({ ok: 0, failed: 2, notAttempted: 18 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/404×1, network×1.*18 not attempted/);
  });
});

describe("scheduleCardHolderNamePublish", () => {
  it("defers the publish with after()", async () => {
    prisma.card.findFirst.mockResolvedValue(assigned("1"));
    scheduleCardHolderNamePublish(connected, "card-1");
    expect(setName).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(setName).toHaveBeenCalledWith("SER-1", "Jane Doe");
  });

  it("schedules nothing for an unconnected fund or no cards", () => {
    scheduleCardHolderNamePublish(unconnected, "card-1");
    scheduleCardHolderNamePublish(connected, []);
    expect(afterCallbacks).toHaveLength(0);
  });
});

describe("renameStampedHolderNames", () => {
  it("rewrites cards stamped with the old name and returns what to publish", async () => {
    prisma.card.findMany.mockResolvedValue([
      { id: "c-old", holderName: "Jane Doe" },
      { id: "c-unnamed", holderName: null },
    ]);
    const ids = await renameStampedHolderNames({
      fundId: "fund-1",
      memberId: "m1",
      oldName: "Jane Doe ",
      newName: "Jane Smith",
    });
    expect(ids).toEqual(["c-old", "c-unnamed"]);
    expect(prisma.card.findMany.mock.calls[0][0].where).toMatchObject({
      fundId: "fund-1",
      memberId: "m1",
    });
    expect(prisma.card.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["c-old"] }, holderName: "Jane Doe" },
      data: { holderName: "Jane Smith" },
    });
  });

  it("is a no-op when the name didn't change", async () => {
    expect(
      await renameStampedHolderNames({
        fundId: "fund-1",
        memberId: "m1",
        oldName: "Jane Doe",
        newName: "Jane Doe",
      }),
    ).toEqual([]);
    expect(prisma.card.findMany).not.toHaveBeenCalled();
  });
});
