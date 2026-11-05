// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { BankingStatus } from "@/services/citizenpay/types";

import {
  SETUP_STEP_KEYS,
  deriveSetupSteps,
  isCitizenPayConnected,
  isSetupComplete,
  type BankingRead,
  type SetupInput,
  type SetupStepKey,
} from "./steps";

// Citizen Pay answered with this status (defaults: no bank at all).
function banking(overrides: Partial<BankingStatus> = {}): BankingRead {
  return { kind: "ok", status: bankingStatus(overrides) };
}

function bankingStatus(overrides: Partial<BankingStatus> = {}): BankingStatus {
  return {
    connected: false,
    status: "not_connected",
    accountReference: null,
    accountName: null,
    onboardingComplete: false,
    paymentInitiationEnabled: false,
    paymentInitiationRequested: false,
    paymentRequestsEnabled: false,
    ready: false,
    ...overrides,
  };
}

const CONNECTED = { citizenPayFundId: "t-1", citizenPayApiKeyId: "0xkey" };

// Bank connected and onboarded, payment initiation requested, not enabled yet.
const WAITING_ON_BANK: Partial<BankingStatus> = {
  connected: true,
  onboardingComplete: true,
  paymentInitiationRequested: true,
};

function input(overrides: Partial<SetupInput> = {}): SetupInput {
  return {
    citizenPayFundId: null,
    citizenPayApiKeyId: null,
    banking: { kind: "not_read" },
    subscriptionAcceptedAt: null,
    ...overrides,
  };
}

function statusOf(i: SetupInput, key: SetupStepKey) {
  return deriveSetupSteps(i).find((s) => s.key === key)?.status;
}

describe("isCitizenPayConnected", () => {
  it("needs both the treasury id and the key id", () => {
    expect(isCitizenPayConnected(CONNECTED)).toBe(true);
    expect(isCitizenPayConnected({ citizenPayFundId: "t-1", citizenPayApiKeyId: null })).toBe(false);
    expect(isCitizenPayConnected({ citizenPayFundId: null, citizenPayApiKeyId: "0xkey" })).toBe(
      false,
    );
  });

  it("treats empty strings as missing", () => {
    expect(isCitizenPayConnected({ citizenPayFundId: "", citizenPayApiKeyId: "0xkey" })).toBe(false);
    expect(isCitizenPayConnected({ citizenPayFundId: "t-1", citizenPayApiKeyId: " " })).toBe(false);
  });
});

describe("deriveSetupSteps", () => {
  it("always returns the three keys in order", () => {
    expect(deriveSetupSteps(input()).map((s) => s.key)).toEqual([...SETUP_STEP_KEYS]);
    expect(
      deriveSetupSteps(
        input({ ...CONNECTED, banking: banking({ ready: true }), subscriptionAcceptedAt: new Date() }),
      ).map((s) => s.key),
    ).toEqual(["citizenpay", "banking", "subscription"]);
  });

  describe("citizenpay", () => {
    it("is done when connected", () => {
      expect(statusOf(input(CONNECTED), "citizenpay")).toBe("done");
    });

    it("is todo otherwise", () => {
      expect(statusOf(input(), "citizenpay")).toBe("todo");
      expect(statusOf(input({ citizenPayFundId: "t-1" }), "citizenpay")).toBe("todo");
    });
  });

  describe("banking", () => {
    it("is blocked until citizenpay is done, whatever the status says", () => {
      expect(statusOf(input(), "banking")).toBe("blocked");
      expect(statusOf(input({ banking: banking({ connected: true, ready: true }) }), "banking")).toBe(
        "blocked",
      );
    });

    it("is done when the connection is ready", () => {
      expect(
        statusOf(input({ ...CONNECTED, banking: banking({ connected: true, ready: true }) }), "banking"),
      ).toBe("done");
    });

    it("is in_progress when payment initiation was requested and the bank is enabling it", () => {
      expect(
        statusOf(input({ ...CONNECTED, banking: banking(WAITING_ON_BANK) }), "banking"),
      ).toBe("in_progress");
    });

    it("is todo when connected but the bank onboarding isn't finished", () => {
      expect(
        statusOf(
          input({ ...CONNECTED, banking: banking({ ...WAITING_ON_BANK, onboardingComplete: false }) }),
          "banking",
        ),
      ).toBe("todo");
    });

    it("is todo when connected but payment initiation was never requested", () => {
      expect(
        statusOf(
          input({ ...CONNECTED, banking: banking({ connected: true, onboardingComplete: true }) }),
          "banking",
        ),
      ).toBe("todo");
    });

    it("is todo when connected with nothing requested yet", () => {
      expect(
        statusOf(input({ ...CONNECTED, banking: banking({ connected: true }) }), "banking"),
      ).toBe("todo");
    });

    it("is todo when not connected", () => {
      expect(statusOf(input({ ...CONNECTED, banking: banking() }), "banking")).toBe("todo");
    });

    it("is unknown when Citizen Pay didn't answer", () => {
      expect(statusOf(input({ ...CONNECTED, banking: { kind: "unavailable" } }), "banking")).toBe(
        "unknown",
      );
    });

    it("is still blocked when unconnected, even if a read failed", () => {
      expect(statusOf(input({ banking: { kind: "unavailable" } }), "banking")).toBe("blocked");
    });

    it("is todo when nothing was read (defensive — only happens before citizenpay is done)", () => {
      expect(statusOf(input({ ...CONNECTED, banking: { kind: "not_read" } }), "banking")).toBe(
        "todo",
      );
    });
  });

  describe("subscription", () => {
    it("is done once accepted", () => {
      expect(statusOf(input({ subscriptionAcceptedAt: new Date() }), "subscription")).toBe("done");
    });

    it("is todo otherwise — never blocked, even before Citizen Pay", () => {
      expect(statusOf(input(), "subscription")).toBe("todo");
      expect(statusOf(input(CONNECTED), "subscription")).toBe("todo");
    });
  });
});

describe("isSetupComplete", () => {
  it("is true only when every step is done", () => {
    const done = deriveSetupSteps(
      input({ ...CONNECTED, banking: banking({ connected: true, ready: true }), subscriptionAcceptedAt: new Date() }),
    );
    expect(isSetupComplete(done)).toBe(true);
  });

  it("is false when any step is not done", () => {
    expect(isSetupComplete(deriveSetupSteps(input()))).toBe(false);
    expect(
      isSetupComplete(
        deriveSetupSteps(input({ ...CONNECTED, banking: banking({ connected: true }), subscriptionAcceptedAt: new Date() })),
      ),
    ).toBe(false);
    expect(
      isSetupComplete(deriveSetupSteps(input({ ...CONNECTED, banking: banking({ ready: true }) }))),
    ).toBe(false);
    expect(
      isSetupComplete(
        deriveSetupSteps(
          input({ ...CONNECTED, banking: { kind: "unavailable" }, subscriptionAcceptedAt: new Date() }),
        ),
      ),
    ).toBe(false);
  });
});
