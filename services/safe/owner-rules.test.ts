// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  checkOwnerChange,
  hasTeamOwner,
  maxOwnersPerPerson,
  ownerRuleDeficits,
  ownerRuleDistance,
  maximumThreshold,
  minimumThreshold,
  ownerRuleViolation,
  type RuleOwner,
} from "./owner-rules";

const passkey = (personId: string): RuleOwner => ({ kind: "PASSKEY", personId });
const member = (personId: string | null): RuleOwner => ({ kind: "MEMBER", personId });
const external: RuleOwner = { kind: "EXTERNAL", personId: null };

describe("owner rules (lost-key recovery)", () => {
  it("leave an all-external Safe alone", () => {
    expect(ownerRuleViolation([external], 1)).toBeNull();
    expect(ownerRuleViolation([external, external], 2)).toBeNull();
    expect(hasTeamOwner([external])).toBe(false);
    expect(minimumThreshold([external, external])).toBe(1);
    expect(maximumThreshold([external, external])).toBe(2);
  });

  it("require a spare owner: owners ≥ threshold + 1", () => {
    expect(ownerRuleViolation([passkey("a"), passkey("b")], 2)).toBe("rules_spare_owner");
    expect(ownerRuleViolation([passkey("a")], 1)).toBe("rules_spare_owner");
    expect(ownerRuleViolation([passkey("a"), passkey("b"), external], 2)).toBeNull();
    expect(ownerRuleViolation([passkey("a"), external, external], 2)).toBeNull();
  });

  it("require that one person's keys alone never meet the threshold", () => {
    expect(ownerRuleViolation([passkey("a"), external], 1)).toBe("rules_one_person");
    // One person mid-migration: server key + passkey = 2 owners of theirs.
    expect(ownerRuleViolation([member("a"), passkey("a"), external, external], 2)).toBe(
      "rules_one_person",
    );
    expect(ownerRuleViolation([member("a"), passkey("a"), external, external], 3)).toBeNull();
    expect(maxOwnersPerPerson([member("a"), passkey("a"), passkey("b")])).toBe(2);
  });

  it("counts an orphaned team key as one person", () => {
    expect(maxOwnersPerPerson([member(null), external])).toBe(1);
    expect(ownerRuleViolation([member(null), external], 1)).toBe("rules_one_person");
    expect(ownerRuleViolation([member(null), external, external], 2)).toBeNull();
  });

  it("the smallest passkey-only Safe is 2-of-3", () => {
    expect(ownerRuleViolation([passkey("a"), passkey("b"), passkey("c")], 2)).toBeNull();
    expect(ownerRuleViolation([passkey("a"), passkey("b"), passkey("c")], 3)).toBe("rules_spare_owner");
    expect(ownerRuleViolation([passkey("a"), passkey("b"), passkey("c")], 1)).toBe("rules_one_person");
    expect(minimumThreshold([passkey("a"), passkey("b"), passkey("c")])).toBe(2);
    expect(maximumThreshold([passkey("a"), passkey("b"), passkey("c")])).toBe(2);
    expect(minimumThreshold([passkey("a"), passkey("b")])).toBeNull();
  });

  it("measures the distance from the rules, custody rule first", () => {
    expect(ownerRuleDeficits([external], 1)).toEqual({ onePerson: 0, spare: 0 });
    expect(ownerRuleDeficits([passkey("a"), passkey("b"), passkey("c")], 2)).toEqual({ onePerson: 0, spare: 0 });
    expect(ownerRuleDeficits([member("a")], 1)).toEqual({ onePerson: 1, spare: 1 });
    expect(ownerRuleDeficits([member("a"), external], 2)).toEqual({ onePerson: 0, spare: 1 });
    expect(ownerRuleDeficits([member("a"), external], 1)).toEqual({ onePerson: 1, spare: 0 });
    // One person meeting the threshold always outweighs a missing spare.
    expect(ownerRuleDistance([member("a"), external], 1)).toBeGreaterThan(
      ownerRuleDistance([member("a"), external], 2),
    );
    expect(ownerRuleDistance([member("a")], 1)).toBe(1001);
  });

  it("lets a legacy Safe that already breaks the rules change as long as it gets no worse", () => {
    const oneOfOne = { owners: [member("a")], threshold: 1 };
    // Adding an external owner at threshold 1 or 2 both move it closer.
    expect(checkOwnerChange(oneOfOne, { owners: [member("a"), external], threshold: 1 })).toEqual({ ok: true });
    expect(checkOwnerChange(oneOfOne, { owners: [member("a"), external], threshold: 2 })).toEqual({ ok: true });
    // Swapping the server key for the member's passkey keeps the distance.
    expect(checkOwnerChange(oneOfOne, { owners: [passkey("a")], threshold: 1 })).toEqual({ ok: true });
    // A 2-of-2 member + external may swap its member key too.
    const twoOfTwo = { owners: [member("a"), external], threshold: 2 };
    expect(checkOwnerChange(twoOfTwo, { owners: [passkey("a"), external], threshold: 2 })).toEqual({ ok: true });
    // …but may not drop to 1-of-2 (one person meets it: further away).
    expect(checkOwnerChange(twoOfTwo, { owners: [member("a"), external], threshold: 1 })).toEqual({
      ok: false,
      violation: "rules_one_person",
      worsens: true,
    });
    // A compliant Safe refuses any change that breaks the rules.
    const good = { owners: [passkey("a"), passkey("b"), passkey("c")], threshold: 2 };
    expect(checkOwnerChange(good, { owners: good.owners, threshold: 3 })).toEqual({
      ok: false,
      violation: "rules_spare_owner",
      worsens: true,
    });
    expect(checkOwnerChange(good, { owners: [...good.owners, external], threshold: 3 })).toEqual({ ok: true });
  });

  it("a 2-of-3 with one member and two externals (the prod shape) passes", () => {
    expect(ownerRuleViolation([member("k"), external, external], 2)).toBeNull();
    // …and still passes once the member key became a passkey.
    expect(ownerRuleViolation([passkey("k"), external, external], 2)).toBeNull();
  });
});
