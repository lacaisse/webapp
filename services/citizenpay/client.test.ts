// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The in-memory dev client follows Citizen Pay's burn-claim rules closely
// enough that the burn flow behaves in dev as it will live.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));

import { CitizenPayApiError } from "./api";
import { getCitizenPayClient } from "./client";

const fund = { id: "f1", citizenPayApiKeyId: null, citizenPayApiKeyEnc: null };
const TX = `0x${"ab".repeat(32)}`;
const T0 = new Date("2026-10-05T09:00:00Z");

// The mock keeps its state at module level; use a fresh payout id per test.
let n = 0;
const freshPayout = () => `mock-test-${++n}`;

async function refusal(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CitizenPayApiError);
  expect((e as CitizenPayApiError).status).toBe(409);
  return (e as CitizenPayApiError).message;
}

beforeEach(() => {
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mock client burn claim", () => {
  it("shows the claim, then marks the payout burnt once a burn is reported", async () => {
    const c = getCitizenPayClient(fund);
    const id = freshPayout();
    const claim = await c.claimPayoutBurn(id);
    expect((await c.getPayoutStatus(id)).burnClaim).toEqual({
      claimId: claim.claimId,
      claimedAt: claim.claimedAt,
      source: "external",
    });

    await c.burnPayout(id, TX, undefined, claim.claimId);
    const live = await c.getPayoutStatus(id);
    expect(live.status).toBe("burnt");
    expect(live.burnClaim).toBeNull();
    expect(await refusal(c.claimPayoutBurn(id))).toBe("payout is already burnt");
    // Same hash again is idempotent; a different one is a double burn.
    expect((await c.burnPayout(id, TX)).duplicateBurn).toBe(false);
    expect((await c.burnPayout(id, `0x${"cd".repeat(32)}`)).duplicateBurn).toBe(true);
  });

  it("refuses a second claim while one is held", async () => {
    const c = getCitizenPayClient(fund);
    const id = freshPayout();
    await c.claimPayoutBurn(id);
    expect(await refusal(c.claimPayoutBurn(id))).toBe("burn already in progress");
  });

  it("refuses to claim complete and not-pending payouts", async () => {
    const c = getCitizenPayClient(fund);
    expect(await refusal(c.claimPayoutBurn("mock-payout-0"))).toBe("payout is already complete");
    expect(await refusal(c.claimPayoutBurn("mock-payout-2"))).toBe("payout is not pending");
  });

  it("releases by claim id at once, but a forced release only after 10 minutes and pinned", async () => {
    const c = getCitizenPayClient(fund);
    const id = freshPayout();
    const claim = await c.claimPayoutBurn(id);

    expect(await refusal(c.releasePayoutBurn(id, { claimId: claim.claimId, force: true }))).toBe(
      "burn claim is too recent",
    );
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60 * 1000));
    expect(await refusal(c.releasePayoutBurn(id, { claimId: "other", force: true }))).toBe(
      "burn claim does not match",
    );
    await c.releasePayoutBurn(id, { claimId: claim.claimId, force: true });
    expect((await c.getPayoutStatus(id)).burnClaim).toBeNull();

    // The burn's own pre-broadcast release: immediate, no force.
    const again = await c.claimPayoutBurn(id);
    await c.releasePayoutBurn(id, { claimId: again.claimId });
    expect((await c.getPayoutStatus(id)).burnClaim).toBeNull();
  });
});
