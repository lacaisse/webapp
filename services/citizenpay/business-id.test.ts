// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the lazy backfill of Fund.citizenPayBusinessId: cached value wins, an
// unconnected fund never calls Citizen Pay, a live read is persisted, and
// failures (read or write) degrade without throwing.
vi.mock("server-only", () => ({}));
const { getTreasuryBusinessId, fundUpdate } = vi.hoisted(() => ({
  getTreasuryBusinessId: vi.fn(),
  fundUpdate: vi.fn(),
}));
vi.mock("./client", () => ({
  getCitizenPayClient: () => ({ getTreasuryBusinessId }),
}));
vi.mock("@/services/db/prisma", () => ({ prisma: { fund: { update: fundUpdate } } }));

import { resolveCitizenPayBusinessId } from "./business-id";

const CONNECTED = { id: "fund-1", citizenPayApiKeyId: "0xkey", citizenPayApiKeyEnc: "enc" };

beforeEach(() => {
  getTreasuryBusinessId.mockReset();
  fundUpdate.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("resolveCitizenPayBusinessId", () => {
  it("returns the cached id without calling Citizen Pay", async () => {
    await expect(
      resolveCitizenPayBusinessId({ ...CONNECTED, citizenPayBusinessId: "biz-cached" }),
    ).resolves.toBe("biz-cached");
    expect(getTreasuryBusinessId).not.toHaveBeenCalled();
    expect(fundUpdate).not.toHaveBeenCalled();
  });

  it("returns null for an unconnected fund without calling Citizen Pay", async () => {
    await expect(
      resolveCitizenPayBusinessId({
        id: "fund-1",
        citizenPayApiKeyId: null,
        citizenPayApiKeyEnc: null,
        citizenPayBusinessId: null,
      }),
    ).resolves.toBeNull();
    expect(getTreasuryBusinessId).not.toHaveBeenCalled();
  });

  it("reads the id live and caches it", async () => {
    getTreasuryBusinessId.mockResolvedValue("biz-live");
    fundUpdate.mockResolvedValue({});
    await expect(
      resolveCitizenPayBusinessId({ ...CONNECTED, citizenPayBusinessId: null }),
    ).resolves.toBe("biz-live");
    expect(fundUpdate).toHaveBeenCalledWith({
      where: { id: "fund-1" },
      data: { citizenPayBusinessId: "biz-live" },
    });
  });

  it("writes nothing when Citizen Pay has no business id", async () => {
    getTreasuryBusinessId.mockResolvedValue(null);
    await expect(
      resolveCitizenPayBusinessId({ ...CONNECTED, citizenPayBusinessId: null }),
    ).resolves.toBeNull();
    expect(fundUpdate).not.toHaveBeenCalled();
  });

  it("returns null when the read fails", async () => {
    getTreasuryBusinessId.mockRejectedValue(new Error("boom"));
    await expect(
      resolveCitizenPayBusinessId({ ...CONNECTED, citizenPayBusinessId: null }),
    ).resolves.toBeNull();
    expect(fundUpdate).not.toHaveBeenCalled();
  });

  it("still returns the id when caching it fails", async () => {
    getTreasuryBusinessId.mockResolvedValue("biz-live");
    fundUpdate.mockRejectedValue(new Error("db down"));
    await expect(
      resolveCitizenPayBusinessId({ ...CONNECTED, citizenPayBusinessId: null }),
    ).resolves.toBe("biz-live");
  });
});
