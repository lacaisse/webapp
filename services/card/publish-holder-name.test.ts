// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// publishCardHolderName against the in-process mock CitizenPay client (no
// CITIZENPAY_API_BASE_URL). Only the database is faked.
vi.mock("server-only", () => ({}));

const prisma = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import {
  publishCardHolderName,
  publishMemberCardHolderNames,
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

beforeEach(() => {
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // The mock client is a fresh instance per getCitizenPayClient call; spy on
  // the shared prototype so every instance is observed.
  const proto = Object.getPrototypeOf(getCitizenPayClient(connected)) as MockProto;
  setName = vi.spyOn(proto, "setCardHolderName");
  prisma.card.findFirst.mockReset();
  prisma.card.findMany.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("publishCardHolderName", () => {
  it("sets the holder's name for an assigned card", async () => {
    prisma.card.findFirst.mockResolvedValue({
      serialNumber: "ABC123",
      memberId: "m1",
      holderName: null,
      member: { firstName: "Jane", lastName: "Doe" },
    });
    await publishCardHolderName(connected, "card-1");
    expect(prisma.card.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "card-1", fundId: "fund-1" } }),
    );
    expect(setName).toHaveBeenCalledWith("ABC123", "Jane Doe");
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
    await publishCardHolderName(unconnected, "card-1");
    expect(prisma.card.findFirst).not.toHaveBeenCalled();
    expect(setName).not.toHaveBeenCalled();
  });

  it("does nothing for a card outside the fund", async () => {
    prisma.card.findFirst.mockResolvedValue(null);
    await publishCardHolderName(connected, "card-x");
    expect(setName).not.toHaveBeenCalled();
  });

  it("swallows a client error and logs it once", async () => {
    prisma.card.findFirst.mockResolvedValue({
      serialNumber: "ABC123",
      memberId: "m1",
      holderName: "Jane Doe",
      member: { firstName: "Jane", lastName: "Doe" },
    });
    setName.mockRejectedValue(
      new CitizenPayApiError("not found", 404, { error: "not found" }),
    );
    await expect(publishCardHolderName(connected, "card-1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("404");
  });
});

describe("publishMemberCardHolderNames", () => {
  it("publishes every card the member holds", async () => {
    prisma.card.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    prisma.card.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      serialNumber: `S-${where.id}`,
      memberId: "m1",
      holderName: where.id === "c2" ? "Kid Doe" : null,
      member: { firstName: "Jane", lastName: "Doe" },
    }));
    await publishMemberCardHolderNames(connected, "m1");
    expect(setName.mock.calls).toEqual([
      ["S-c1", "Jane Doe"],
      ["S-c2", "Kid Doe"],
    ]);
  });
});
