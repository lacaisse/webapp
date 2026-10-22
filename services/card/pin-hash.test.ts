// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CARD_PIN_HASH_VERSION, hashCardPin } from "./pin-hash";

describe("hashCardPin", () => {
  it("is pay-pos's digest: keccak256 of the versioned, serial-salted message", () => {
    expect(CARD_PIN_HASH_VERSION).toBe("v1");
    // keccak256("citizenpay:card-pin:v1:04A1B2C3D4E5F6:1234") — the message
    // pay-pos's pin_hash.dart builds, pinned to the same vector the Citizen
    // Pay dashboard pins, so a drift on any side shows up here.
    const got = hashCardPin("04A1B2C3D4E5F6", "1234");
    expect(got).toBe(
      "8d3868d33fd68304a8e58fa8413b2484e9eef01fa93be8ec341aa0ebc271acae",
    );
    expect(got).toMatch(/^[0-9a-f]{64}$/);
    // keccak256, not NIST SHA3-256 (they differ in the padding byte).
    const sha3 = createHash("sha3-256")
      .update("citizenpay:card-pin:v1:04A1B2C3D4E5F6:1234")
      .digest("hex");
    expect(got).not.toBe(sha3);
  });

  it("salts with the exact serial: same PIN, other card, other digest", () => {
    expect(hashCardPin("04A1", "1234")).not.toBe(hashCardPin("04A2", "1234"));
    expect(hashCardPin("04A1", "1234")).not.toBe(hashCardPin("04a1", "1234"));
    expect(hashCardPin("04A1", "1234")).not.toBe(hashCardPin("04A1", "1235"));
  });
});
