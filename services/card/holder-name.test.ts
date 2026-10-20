// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  backfillDecision,
  holderDisplayName,
  publishedHolderName,
} from "./holder-name";

const jane = { firstName: "Jane", lastName: "Doe" };

describe("holderDisplayName", () => {
  it("prefers the card's own holderName", () => {
    expect(holderDisplayName(jane, "Tom Doe")).toBe("Tom Doe");
  });

  it("trims the holderName", () => {
    expect(holderDisplayName(jane, "  Tom Doe ")).toBe("Tom Doe");
  });

  it("falls back to the member's first + last name", () => {
    expect(holderDisplayName(jane, null)).toBe("Jane Doe");
  });

  it("treats a blank holderName as unset", () => {
    expect(holderDisplayName(jane, "   ")).toBe("Jane Doe");
  });

  it("trims a member name with an empty part", () => {
    expect(holderDisplayName({ firstName: "Jane", lastName: "" }, null)).toBe(
      "Jane",
    );
  });

  it("is null with neither a holderName nor a member", () => {
    expect(holderDisplayName(null, null)).toBeNull();
  });

  it("is null for a member with no name at all", () => {
    expect(holderDisplayName({ firstName: " ", lastName: "" }, null)).toBeNull();
  });
});

describe("publishedHolderName", () => {
  it("publishes the holder name of an assigned card", () => {
    expect(
      publishedHolderName({ memberId: "m1", holderName: null, member: jane }),
    ).toBe("Jane Doe");
  });

  it("resets an unassigned card even when a stale holderName remains", () => {
    expect(
      publishedHolderName({ memberId: null, holderName: "Jane Doe", member: null }),
    ).toBeNull();
  });
});

describe("backfillDecision (scripts/sync-holder-names.ts)", () => {
  it("publishes a card stamped with the member's current name", () => {
    expect(
      backfillDecision({ memberId: "m1", holderName: "Jane Doe", member: jane }),
    ).toEqual({ kind: "publish", name: "Jane Doe" });
  });

  it("publishes the member's name for an unnamed card", () => {
    expect(
      backfillDecision({ memberId: "m1", holderName: null, member: jane }),
    ).toEqual({ kind: "publish", name: "Jane Doe" });
  });

  it("holds back a card whose holderName differs from the member's current name", () => {
    expect(
      backfillDecision({ memberId: "m1", holderName: "Jane Maiden", member: jane }),
    ).toEqual({ kind: "stale", holderName: "Jane Maiden", memberName: "Jane Doe" });
  });

  it("skips an unassigned card", () => {
    expect(
      backfillDecision({ memberId: null, holderName: "Jane Doe", member: null }),
    ).toEqual({ kind: "noName" });
  });
});
