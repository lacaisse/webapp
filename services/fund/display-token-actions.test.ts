// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// addDisplayTokenAction / removeDisplayTokenAction (services/fund/
// settings-actions.ts): ADMIN-gated, host-fund scoped, contract read stubbed.
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
const { requireFundRole } = vi.hoisted(() => ({ requireFundRole: vi.fn() }));
vi.mock("@/services/auth/dal", () => ({ requireFundRole }));
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("@/services/db/prisma", () => ({ prisma: { fundDisplayToken: db } }));
const meta = vi.hoisted(() => ({ readErc20Metadata: vi.fn() }));
vi.mock("@/services/token/erc20-metadata", async (orig) => ({
  ...(await orig<typeof import("@/services/token/erc20-metadata")>()),
  readErc20Metadata: meta.readErc20Metadata,
}));

import { Erc20MetadataError } from "@/services/token/erc20-metadata";

import { addDisplayTokenAction, removeDisplayTokenAction } from "./settings-actions";

const USDCE = "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0";
const FUND_TOKEN = "0x5815E61eF72c9E6107b5c5A05FD121F334f7a7f1";
const EURE = "0x420ca0f9b9b604ce0fd9c18ef134c705e5fa3430";
const K = "fund.settings.token.customTokens.errors.";

beforeEach(() => {
  vi.clearAllMocks();
  requireFundRole.mockResolvedValue({
    fund: { id: "fund-1", tokenChainId: 100, tokenAddress: FUND_TOKEN },
  });
  db.findMany.mockResolvedValue([]);
  db.create.mockImplementation(async ({ data }) => ({ id: "dt-1", ...data }));
  meta.readErc20Metadata.mockResolvedValue({
    address: USDCE,
    symbol: "USDC.e",
    name: "Bridged USDC",
    decimals: 6,
  });
});

describe("addDisplayTokenAction", () => {
  it("reads the contract on the fund's chain and stores the checksummed row for the host fund", async () => {
    const res = await addDisplayTokenAction({ address: ` ${USDCE.toLowerCase()} ` });

    expect(requireFundRole).toHaveBeenCalledWith("ADMIN");
    expect(meta.readErc20Metadata).toHaveBeenCalledWith(100, USDCE);
    expect(db.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { fundId: "fund-1", address: USDCE, symbol: "USDC.e", name: "Bridged USDC", decimals: 6 },
      }),
    );
    expect(res).toMatchObject({ ok: true, token: { id: "dt-1", symbol: "USDC.e" } });
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { fundId: "fund-1" } }));
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/accounts", "layout");
  });

  it("refuses the fund token and the built-in extra tokens", async () => {
    expect(await addDisplayTokenAction({ address: FUND_TOKEN.toLowerCase() })).toEqual({
      error: `${K}alreadyShown`,
    });
    expect(await addDisplayTokenAction({ address: EURE })).toEqual({ error: `${K}alreadyShown` });
    expect(meta.readErc20Metadata).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });

  it("refuses a token the fund already registered", async () => {
    db.findMany.mockResolvedValue([{ address: USDCE }]);
    expect(await addDisplayTokenAction({ address: USDCE.toLowerCase() })).toEqual({
      error: `${K}duplicate`,
    });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("maps a non-ERC-20 to notErc20 and an RPC failure to readFailed", async () => {
    meta.readErc20Metadata.mockRejectedValueOnce(new Erc20MetadataError("not_erc20", "no code"));
    expect(await addDisplayTokenAction({ address: USDCE })).toEqual({ error: `${K}notErc20` });

    vi.spyOn(console, "error").mockImplementation(() => {});
    meta.readErc20Metadata.mockRejectedValueOnce(new Error("Alchemy eth_getCode HTTP 502"));
    expect(await addDisplayTokenAction({ address: USDCE })).toEqual({ error: `${K}readFailed` });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("refuses a malformed address", async () => {
    expect(await addDisplayTokenAction({ address: "0x1234" })).toEqual({
      error: `${K}addressInvalid`,
    });
  });
});

describe("removeDisplayTokenAction", () => {
  it("deletes only within the host fund", async () => {
    db.deleteMany.mockResolvedValue({ count: 1 });
    expect(await removeDisplayTokenAction({ id: "dt-1" })).toEqual({ ok: true });
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { id: "dt-1", fundId: "fund-1" } });

    db.deleteMany.mockResolvedValue({ count: 0 }); // e.g. another fund's id
    expect(await removeDisplayTokenAction({ id: "dt-other" })).toEqual({ error: `${K}notFound` });
  });
});
