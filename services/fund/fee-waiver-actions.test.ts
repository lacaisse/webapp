// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fixed-fee waivers: ADMIN-gated, and a business id from the browser reaches
// Citizen Pay only once it is shown to belong to THIS fund. Prisma, the DAL
// and the CP client are stubbed.
vi.mock("server-only", () => ({}));
const { requireFundRole, merchantFindFirst, client, getCitizenPayClient } = vi.hoisted(() => {
  const client = {
    addFeeWaiver: vi.fn(),
    removeFeeWaiver: vi.fn(),
    listFeeWaivers: vi.fn(),
  };
  return {
    requireFundRole: vi.fn(),
    merchantFindFirst: vi.fn(),
    client,
    getCitizenPayClient: vi.fn(() => client),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/services/auth/dal", () => ({ requireFundRole }));
vi.mock("@/services/db/prisma", () => ({
  prisma: { merchant: { findFirst: merchantFindFirst } },
}));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient }));

import { CitizenPayApiError } from "@/services/citizenpay/api";

import { addFeeWaiverAction, removeFeeWaiverAction } from "./fee-waiver-actions";

const fund = {
  id: "fund-1",
  citizenPayFundId: "t-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "enc",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireFundRole.mockResolvedValue({ fund });
  getCitizenPayClient.mockImplementation(() => client);
  merchantFindFirst.mockResolvedValue({ id: "m-1" });
  client.listFeeWaivers.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("role gate", () => {
  it.each([
    ["add", addFeeWaiverAction],
    ["remove", removeFeeWaiverAction],
  ])("%s requires ADMIN and does nothing when refused", async (_name, action) => {
    requireFundRole.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(action({ businessId: "b-1" })).rejects.toThrow("NEXT_REDIRECT");
    expect(requireFundRole).toHaveBeenCalledWith("ADMIN");
    expect(merchantFindFirst).not.toHaveBeenCalled();
    expect(client.addFeeWaiver).not.toHaveBeenCalled();
    expect(client.removeFeeWaiver).not.toHaveBeenCalled();
  });
});

describe("addFeeWaiverAction", () => {
  it("adds a business one of the fund's merchants belongs to", async () => {
    await expect(addFeeWaiverAction({ businessId: " b-1 " })).resolves.toEqual({ ok: true });
    expect(merchantFindFirst).toHaveBeenCalledWith({
      where: { fundId: "fund-1", citizenPayBusinessId: "b-1" },
      select: { id: true },
    });
    expect(client.addFeeWaiver).toHaveBeenCalledExactlyOnceWith("b-1");
  });

  it("refuses a business none of the fund's merchants belongs to", async () => {
    merchantFindFirst.mockResolvedValue(null);
    await expect(addFeeWaiverAction({ businessId: "b-other" })).resolves.toEqual({
      error: "fund.settings.fees.waivers.errors.notFound",
    });
    expect(client.addFeeWaiver).not.toHaveBeenCalled();
  });

  it("refuses an empty id without a lookup", async () => {
    await expect(addFeeWaiverAction({ businessId: "  " })).resolves.toEqual({
      error: "fund.settings.fees.waivers.errors.notFound",
    });
    expect(merchantFindFirst).not.toHaveBeenCalled();
  });

  it("says not connected when the fund has no treasury", async () => {
    requireFundRole.mockResolvedValue({ fund: { ...fund, citizenPayFundId: null } });
    await expect(addFeeWaiverAction({ businessId: "b-1" })).resolves.toEqual({
      error: "fund.settings.fees.waivers.errors.notConnected",
    });
    expect(client.addFeeWaiver).not.toHaveBeenCalled();
  });

  it("maps a 404 to 'not accepting the token' and other failures to 'failed'", async () => {
    client.addFeeWaiver.mockRejectedValueOnce(new CitizenPayApiError("nf", 404, null));
    await expect(addFeeWaiverAction({ businessId: "b-1" })).resolves.toEqual({
      error: "fund.settings.fees.waivers.errors.notAccepting",
    });
    client.addFeeWaiver.mockRejectedValueOnce(new CitizenPayApiError("bad", 400, null));
    await expect(addFeeWaiverAction({ businessId: "b-1" })).resolves.toEqual({
      error: "fund.settings.fees.waivers.errors.failed",
    });
  });
});

describe("removeFeeWaiverAction", () => {
  it("removes a business of the fund", async () => {
    await expect(removeFeeWaiverAction({ businessId: "b-1" })).resolves.toEqual({ ok: true });
    expect(client.removeFeeWaiver).toHaveBeenCalledExactlyOnceWith("b-1");
  });

  it("removes a waiver the treasury holds even without a local merchant", async () => {
    merchantFindFirst.mockResolvedValue(null);
    client.listFeeWaivers.mockResolvedValue([
      { businessId: "b-gone", businessName: "Old shop", createdAt: null },
    ]);
    await expect(removeFeeWaiverAction({ businessId: "b-gone" })).resolves.toEqual({ ok: true });
    expect(client.removeFeeWaiver).toHaveBeenCalledExactlyOnceWith("b-gone");
  });

  it("refuses a business that is neither the fund's nor in the treasury's list", async () => {
    merchantFindFirst.mockResolvedValue(null);
    await expect(removeFeeWaiverAction({ businessId: "b-other" })).resolves.toEqual({
      error: "fund.settings.fees.waivers.errors.notFound",
    });
    expect(client.removeFeeWaiver).not.toHaveBeenCalled();
  });
});
