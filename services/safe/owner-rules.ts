// SPDX-License-Identifier: AGPL-3.0-or-later

// Recovery rules for a Safe that has team owners (passkey or legacy server
// key). Pure, shared by the create / owner-change cores and the dialogs.
//
// A passkey lives on one person's device. If that device is lost, the other
// owners must still (1) reach the threshold without it and (2) be able to
// swap it for a new key — an owner change that itself needs the threshold.
// So, whenever at least one owner is a team member:
//   • spare owner:  owners ≥ threshold + 1
//   • one person:   threshold > the number of owners that belong to one
//                   person (their passkey plus any legacy server key) — one
//                   person's keys alone never meet the threshold.
// A Safe owned by external wallets only is left to its owners' judgement.

import type { SafeErrorCode } from "@/services/safe/types";

export type RuleOwner = {
  kind: "MEMBER" | "EXTERNAL" | "PASSKEY";
  // Who the key belongs to (user id) for MEMBER / PASSKEY owners; null for
  // an external address or an orphaned team key.
  personId: string | null;
};

export type OwnerRuleViolation = Extract<SafeErrorCode, "rules_spare_owner" | "rules_one_person">;

export function hasTeamOwner(owners: RuleOwner[]): boolean {
  return owners.some((o) => o.kind !== "EXTERNAL");
}

/** The largest number of owners one person holds. */
export function maxOwnersPerPerson(owners: RuleOwner[]): number {
  const counts = new Map<string, number>();
  let orphans = 0;
  for (const o of owners) {
    if (o.kind === "EXTERNAL") continue;
    if (o.personId === null) {
      orphans++;
      continue;
    }
    counts.set(o.personId, (counts.get(o.personId) ?? 0) + 1);
  }
  // An orphaned team key (member left, row lost its person) is counted as
  // its own person: it can still be one person's.
  return Math.max(0, ...counts.values(), orphans > 0 ? 1 : 0);
}

/**
 * The first rule the owner set / threshold would break, or null when it
 * passes (also null for an all-external set). `threshold` is the threshold
 * AFTER the change being checked.
 */
export function ownerRuleViolation(
  owners: RuleOwner[],
  threshold: number,
): OwnerRuleViolation | null {
  if (!hasTeamOwner(owners)) return null;
  if (owners.length < threshold + 1) return "rules_spare_owner";
  if (threshold <= maxOwnersPerPerson(owners)) return "rules_one_person";
  return null;
}

/** The smallest threshold the rules allow for this owner set (or null when none fits). */
export function minimumThreshold(owners: RuleOwner[]): number | null {
  if (!hasTeamOwner(owners)) return 1;
  const min = maxOwnersPerPerson(owners) + 1;
  return owners.length >= min + 1 ? min : null;
}

/** The largest threshold the rules allow (owners − 1 with team owners). */
export function maximumThreshold(owners: RuleOwner[]): number {
  if (!hasTeamOwner(owners)) return owners.length;
  return Math.max(0, owners.length - 1);
}
