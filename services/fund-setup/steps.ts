// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BankingStatus } from "@/services/citizenpay/types";

// Fund-setup checklist — the self-service onboarding a fund walks through
// before it can run on La Caisse. Pure, so the server data layer, client
// components and tests all derive the same statuses from the same inputs.
//
// Rules:
//   citizenpay   done when the fund holds a Citizen Pay treasury id AND an API
//                key id (registered + key minted), else todo.
//   banking      blocked until citizenpay is done (the bank connection belongs
//                to the treasury's business, which doesn't exist before).
//                Then, from Citizen Pay's banking status:
//                  - read failed (`unavailable`)            → unknown
//                  - `ready` (payment initiation enabled)   → done
//                  - connected + bank onboarding complete + payment initiation
//                    requested but not enabled yet          → in_progress
//                    (the bank is working on it; nothing for the fund to do)
//                  - anything else (no bank, onboarding unfinished, payment
//                    initiation never requested)            → todo
//                An unread status (`not_read`) only happens before citizenpay
//                is done; should it reach here, it reads as todo.
//   subscription done once an OWNER accepted the hosting plan OR the fund's
//                hosting was waived (a redeemed waiver code, or a platform
//                admin's script), else todo. Never blocked — a fund may
//                accept before connecting.

export const SETUP_STEP_KEYS = ["citizenpay", "banking", "subscription"] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

// done = finished; todo = the fund can act now; in_progress = waiting on the
// bank (payment initiation requested, not enabled yet); blocked = an earlier
// step must be done first; unknown = Citizen Pay did not answer — not done,
// not actionable.
export type SetupStepStatus = "done" | "todo" | "in_progress" | "blocked" | "unknown";
export type SetupStep = { key: SetupStepKey; status: SetupStepStatus };

// What the server learnt about the treasury's bank connection:
//   not_read     the fund isn't connected to Citizen Pay, so nothing was read
//   unavailable  Citizen Pay was asked and the read failed
//   ok           Citizen Pay answered
export type BankingRead =
  | { kind: "not_read" }
  | { kind: "unavailable" }
  | { kind: "ok"; status: BankingStatus };

export type SetupInput = {
  citizenPayFundId: string | null;
  citizenPayApiKeyId: string | null;
  banking: BankingRead;
  subscriptionAcceptedAt: Date | null;
  subscriptionWaivedAt: Date | null;
};

function present(value: string | null): boolean {
  return value != null && value.trim() !== "";
}

export function isCitizenPayConnected(
  input: Pick<SetupInput, "citizenPayFundId" | "citizenPayApiKeyId">,
): boolean {
  return present(input.citizenPayFundId) && present(input.citizenPayApiKeyId);
}

function bankingStatus(input: SetupInput, citizenPayDone: boolean): SetupStepStatus {
  if (!citizenPayDone) return "blocked";
  if (input.banking.kind === "unavailable") return "unknown";
  if (input.banking.kind === "not_read") return "todo";
  const status = input.banking.status;
  if (status.ready) return "done";
  if (
    status.connected &&
    status.onboardingComplete &&
    status.paymentInitiationRequested &&
    !status.paymentInitiationEnabled
  ) {
    return "in_progress";
  }
  return "todo";
}

// The hosting question is closed: accepted (paying) or waived (free).
export function isSubscriptionSettled(
  input: Pick<SetupInput, "subscriptionAcceptedAt" | "subscriptionWaivedAt">,
): boolean {
  return input.subscriptionAcceptedAt != null || input.subscriptionWaivedAt != null;
}

// Always the three keys, in SETUP_STEP_KEYS order.
export function deriveSetupSteps(input: SetupInput): SetupStep[] {
  const citizenPayDone = isCitizenPayConnected(input);
  const statuses: Record<SetupStepKey, SetupStepStatus> = {
    citizenpay: citizenPayDone ? "done" : "todo",
    banking: bankingStatus(input, citizenPayDone),
    subscription: isSubscriptionSettled(input) ? "done" : "todo",
  };
  return SETUP_STEP_KEYS.map((key) => ({ key, status: statuses[key] }));
}

export function isSetupComplete(steps: SetupStep[]): boolean {
  return steps.every((step) => step.status === "done");
}
