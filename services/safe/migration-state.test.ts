// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  migrationRows,
  replacementRefusal,
  serverKeyErasable,
  type MigrationOwnerInput,
  type MigrationSwapInput,
} from "./migration-state";

const OLD_A = "0xAAAA000000000000000000000000000000000001";
const NEW_A = "0xAAAA000000000000000000000000000000000002";
const OLD_B = "0xBBBB000000000000000000000000000000000001";
const NEW_B = "0xBBBB000000000000000000000000000000000002";
const EXT = "0xEEEE000000000000000000000000000000000001";

const owners: MigrationOwnerInput[] = [
  { address: OLD_A, kind: "MEMBER", userId: "a", passkeyReplaced: false },
  { address: OLD_B, kind: "PASSKEY", userId: "b", passkeyReplaced: true },
  { address: EXT, kind: "EXTERNAL", userId: null, passkeyReplaced: false },
  { address: NEW_B, kind: "PASSKEY", userId: "b", passkeyReplaced: false },
];

describe("migration state machine", () => {
  it("lists server-key owners and replaced passkeys, nothing else", () => {
    const rows = migrationRows(owners, new Map(), []);
    expect(rows.map((r) => [r.ownerAddress, r.reason, r.step])).toEqual([
      [OLD_A, "server_key", "register"],
      [OLD_B, "replaced_passkey", "register"],
    ]);
  });

  it("walks register → deploy → propose as the member's passkey appears", () => {
    const registered = new Map([["a", { address: NEW_A, deployed: false }]]);
    expect(migrationRows(owners, registered, [])[0]).toMatchObject({
      step: "deploy",
      targetAddress: NEW_A,
    });
    const deployed = new Map([["a", { address: NEW_A, deployed: true }]]);
    expect(migrationRows(owners, deployed, [])[0]).toMatchObject({
      step: "propose",
      targetAddress: NEW_A,
    });
  });

  it("a replaced passkey whose successor is registered is ready to propose", () => {
    const targets = new Map([["b", { address: NEW_B, deployed: true }]]);
    const row = migrationRows(owners, targets, []).find((r) => r.ownerAddress === OLD_B)!;
    expect(row).toMatchObject({ reason: "replaced_passkey", step: "propose", targetAddress: NEW_B });
  });

  it("a replaced passkey with no successor yet (target = itself) still needs a registration", () => {
    const targets = new Map([["b", { address: OLD_B, deployed: true }]]);
    const row = migrationRows(owners, targets, []).find((r) => r.ownerAddress === OLD_B)!;
    expect(row).toMatchObject({ step: "register", targetAddress: null });
  });

  it("follows the open swap once proposed: signing / executing / failed", () => {
    const targets = new Map([["a", { address: NEW_A, deployed: true }]]);
    const swap = (status: MigrationSwapInput["status"]): MigrationSwapInput => ({
      transactionId: "tx-1",
      oldOwner: OLD_A.toLowerCase(),
      newOwner: NEW_A,
      status,
      signatures: 1,
    });
    expect(migrationRows(owners, targets, [swap("PENDING")])[0]).toMatchObject({
      step: "signing",
      targetAddress: NEW_A,
      swap: { transactionId: "tx-1", signatures: 1 },
    });
    expect(migrationRows(owners, targets, [swap("EXECUTING")])[0].step).toBe("executing");
    expect(migrationRows(owners, targets, [swap("FAILED")])[0].step).toBe("failed");
  });

  it("an orphaned server key (member gone) is still listed, with no target", () => {
    const rows = migrationRows(
      [{ address: OLD_A, kind: "MEMBER", userId: null, passkeyReplaced: false }],
      new Map(),
      [],
    );
    expect(rows).toEqual([
      { ownerAddress: OLD_A, reason: "server_key", userId: null, targetAddress: null, step: "register", swap: null },
    ]);
  });

  it("a legacy ciphertext may be erased only once migrated and listed by no Safe at all", () => {
    expect(serverKeyErasable(true, 0)).toBe(true);
    expect(serverKeyErasable(true, 1)).toBe(false); // still an owner somewhere (archived counts)
    expect(serverKeyErasable(false, 0)).toBe(false); // never migrated: keep the key
  });

  it("refuses a replacement while a previous one still owns a Safe, or past the daily cap", () => {
    expect(replacementRefusal(0, 0, 3)).toBeNull();
    expect(replacementRefusal(1, 0, 3)).toBe("passkey_replace_pending");
    expect(replacementRefusal(0, 3, 3)).toBe("passkey_rate_limited");
    expect(replacementRefusal(0, 2, 3)).toBeNull();
    expect(replacementRefusal(2, 5, 3)).toBe("passkey_replace_pending");
  });
});
