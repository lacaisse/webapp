// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  hasTeamOwner,
  maxOwnersPerPerson,
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

  it("a 2-of-3 with one member and two externals (the prod shape) passes", () => {
    expect(ownerRuleViolation([member("k"), external, external], 2)).toBeNull();
    // …and still passes once the member key became a passkey.
    expect(ownerRuleViolation([passkey("k"), external, external], 2)).toBeNull();
  });
});
