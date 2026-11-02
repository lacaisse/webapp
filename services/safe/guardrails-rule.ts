// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure part of services/safe/guardrails.ts (unit-tested).

export type SafeSignerShape = {
  id: string;
  name: string;
  threshold: number;
  // MEMBER (legacy server key) and PASSKEY owners belong to a person;
  // EXTERNAL owners sign in Safe{Wallet}.
  owners: { kind: "MEMBER" | "EXTERNAL" | "PASSKEY"; userId: string | null }[];
};

/**
 * Safes that could no longer reach their threshold if `leavingUserId` lost
 * ADMIN access: reachable signers are the other team owners (server key or
 * passkey) whose user is still ADMIN+ (`adminUserIds`) plus every EXTERNAL
 * owner.
 */
export function blockingSafes(
  safes: SafeSignerShape[],
  leavingUserId: string,
  adminUserIds: Set<string>,
): { id: string; name: string }[] {
  return safes
    .filter((s) => {
      const reachable = s.owners.filter(
        (o) =>
          o.kind === "EXTERNAL" ||
          (o.userId !== null && o.userId !== leavingUserId && adminUserIds.has(o.userId)),
      ).length;
      return reachable < s.threshold;
    })
    .map(({ id, name }) => ({ id, name }));
}
