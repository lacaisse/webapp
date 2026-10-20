// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// retryPendingMints must never pick an open-banking card top-up's mint: that
// op sits PENDING with no txHash while mintToken waits (or after a killed
// function), and re-submitting it would credit the card twice. The top-up's
// own sweep (services/card-topup/settle.ts) owns its retries.

vi.mock("server-only", () => ({}));

type Op = {
  id: string;
  type: string;
  status: string;
  txHash: string | null;
  account: string;
  amount: string;
  cardTopUpId: string | null;
  fund: { id: string; citizenPayFundId: string; citizenPayApiKeyId: null; citizenPayApiKeyEnc: null };
};
const ops = vi.hoisted(() => [] as Op[]);

const prisma = vi.hoisted(() => ({
  tokenOperation: {
    // Evaluate the where the way Postgres would for the fields it uses.
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      ops.filter((op) => {
        if (where.type !== undefined && op.type !== where.type) return false;
        if (where.status !== undefined && op.status !== where.status) return false;
        if ("txHash" in where && where.txHash === null && op.txHash !== null) return false;
        const topUp = where.cardTopUp as { is: null } | undefined;
        if (topUp && topUp.is === null && op.cardTopUpId !== null) return false;
        return true;
      }),
    ),
    update: vi.fn(async () => ({})),
  },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const cp = vi.hoisted(() => ({ submitMint: vi.fn() }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));

import { retryPendingMints } from "./retry";

const fund = { id: "fund-1", citizenPayFundId: "t-1", citizenPayApiKeyId: null, citizenPayApiKeyEnc: null };

beforeEach(() => {
  vi.clearAllMocks();
  ops.length = 0;
  cp.submitMint.mockResolvedValue({ txHash: "0xretried" });
});

describe("retryPendingMints", () => {
  it("skips a card top-up's in-flight mint and retries the others", async () => {
    ops.push(
      { id: "op-topup", type: "MINT", status: "PENDING", txHash: null, account: "0xa", amount: "12.50", cardTopUpId: "topup-1", fund },
      { id: "op-tier", type: "MINT", status: "PENDING", txHash: null, account: "0xb", amount: "40.00", cardTopUpId: null, fund },
    );
    const stats = await retryPendingMints();

    expect(prisma.tokenOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cardTopUp: { is: null } }),
      }),
    );
    expect(stats).toEqual({ attempted: 1, submitted: 1, failed: 0 });
    expect(cp.submitMint).toHaveBeenCalledTimes(1);
    expect(cp.submitMint).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "op-tier" }),
    );
  });
});
