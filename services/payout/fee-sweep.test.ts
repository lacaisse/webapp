// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  FEE_SETTLING_MAX_ATTEMPTS,
  feeSettlingRetryDelayMs,
  isFeesSettlingMessage,
  isNothingToSweepMessage,
} from "./fee-sweep";

describe("fee sweep answers (citizenpay/api#277)", () => {
  it("recognises the api's two non-failure texts", () => {
    expect(
      isFeesSettlingMessage("transaction fees of this payout are still settling, retry shortly"),
    ).toBe(true);
    expect(isNothingToSweepMessage("payout has no fees or manual deduction to transfer")).toBe(true);
    expect(isFeesSettlingMessage("insufficient balance")).toBe(false);
    expect(isNothingToSweepMessage(null)).toBe(false);
  });

  it("backs off 5 s, 10 s, 20 s … capped at 5 min, and stops", () => {
    expect(feeSettlingRetryDelayMs(1)).toBe(5_000);
    expect(feeSettlingRetryDelayMs(2)).toBe(10_000);
    expect(feeSettlingRetryDelayMs(3)).toBe(20_000);
    expect(feeSettlingRetryDelayMs(7)).toBe(300_000);
    expect(feeSettlingRetryDelayMs(FEE_SETTLING_MAX_ATTEMPTS)).toBe(300_000);
    expect(feeSettlingRetryDelayMs(FEE_SETTLING_MAX_ATTEMPTS + 1)).toBeNull();
    expect(feeSettlingRetryDelayMs(0)).toBeNull();
  });
});
