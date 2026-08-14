// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseSignupPrefill, type PrefillFieldDef } from "./prefill";

const select: PrefillFieldDef = {
  key: "diet",
  type: "SELECT",
  options: [
    { value: "vegan", label: "Vegan" },
    { value: "omni", label: "Omnivore" },
  ],
};

const multi: PrefillFieldDef = {
  key: "days",
  type: "MULTISELECT",
  options: [
    { value: "mon", label: "Monday" },
    { value: "tue", label: "Tuesday" },
    { value: "wed", label: "Wednesday" },
  ],
};

const text: PrefillFieldDef = { key: "profession", type: "TEXT", options: [] };
const number: PrefillFieldDef = { key: "kids", type: "NUMBER", options: [] };
const date: PrefillFieldDef = { key: "born", type: "DATE", options: [] };
const check: PrefillFieldDef = { key: "consent", type: "CHECKBOX", options: [] };

describe("parseSignupPrefill — builtins", () => {
  it("fills the identity fields from matching params", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.org",
      }),
      [],
    );
    expect(result.firstName).toBe("Ada");
    expect(result.lastName).toBe("Lovelace");
    expect(result.email).toBe("ada@example.org");
  });

  it("leaves absent builtins as empty strings", () => {
    const result = parseSignupPrefill(new URLSearchParams({ firstName: "Ada" }), []);
    expect(result.lastName).toBe("");
    expect(result.email).toBe("");
  });

  it("trims surrounding whitespace", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ firstName: "  Ada  " }),
      [],
    );
    expect(result.firstName).toBe("Ada");
  });

  it("accepts a well-formed contribution amount", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ contributionAmount: "42.50" }),
      [],
    );
    expect(result.contributionAmount).toBe("42.50");
  });

  it("drops an amount the signup schema would reject", () => {
    for (const bad of ["12.345", "abc", "-5", "1,50"]) {
      const result = parseSignupPrefill(
        new URLSearchParams({ contributionAmount: bad }),
        [],
      );
      expect(result.contributionAmount).toBe("");
    }
  });

  it("ignores the amount entirely when the form won't render that input", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ contributionAmount: "42.50" }),
      [],
      { showContribution: false },
    );
    expect(result.contributionAmount).toBe("");
  });
});

describe("parseSignupPrefill — reserved params", () => {
  it("never reads a field whose key collides with a reserved param", () => {
    const refField: PrefillFieldDef = { key: "ref", type: "TEXT", options: [] };
    const stepField: PrefillFieldDef = { key: "step", type: "TEXT", options: [] };
    const result = parseSignupPrefill(
      new URLSearchParams({ ref: "SPONSOR1", step: "2" }),
      [refField, stepField],
    );
    expect(result.extras).toEqual({});
  });
});

describe("parseSignupPrefill — typed extras", () => {
  it("fills a text field", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ profession: "engineer" }),
      [text],
    );
    expect(result.extras.profession).toBe("engineer");
  });

  it("truncates an overlong text value rather than storing it whole", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ profession: "x".repeat(900) }),
      [text],
    );
    expect((result.extras.profession as string).length).toBe(500);
  });

  it("keeps a SELECT value that matches an option", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ diet: "vegan" }),
      [select],
    );
    expect(result.extras.diet).toBe("vegan");
  });

  it("drops a SELECT value that matches no option", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ diet: "carnivore" }),
      [select],
    );
    expect(result.extras.diet).toBeUndefined();
  });

  it("splits a MULTISELECT on commas and keeps only valid options", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ days: "mon, wed, sat" }),
      [multi],
    );
    expect(result.extras.days).toEqual(["mon", "wed"]);
  });

  it("dedupes repeated MULTISELECT values", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ days: "mon,mon,tue" }),
      [multi],
    );
    expect(result.extras.days).toEqual(["mon", "tue"]);
  });

  it("drops a MULTISELECT with no valid values at all", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ days: "sat,sun" }),
      [multi],
    );
    expect(result.extras.days).toBeUndefined();
  });

  it("reads the documented truthy and falsy CHECKBOX spellings", () => {
    for (const yes of ["1", "true", "TRUE", "yes", "on"]) {
      const r = parseSignupPrefill(new URLSearchParams({ consent: yes }), [check]);
      expect(r.extras.consent).toBe(true);
    }
    for (const no of ["0", "false", "no", "off"]) {
      const r = parseSignupPrefill(new URLSearchParams({ consent: no }), [check]);
      expect(r.extras.consent).toBe(false);
    }
  });

  it("treats an unrecognised CHECKBOX value as unspecified", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ consent: "maybe" }),
      [check],
    );
    expect(result.extras.consent).toBeUndefined();
  });

  it("keeps a numeric NUMBER and drops a non-numeric one", () => {
    expect(
      parseSignupPrefill(new URLSearchParams({ kids: "3" }), [number]).extras.kids,
    ).toBe("3");
    expect(
      parseSignupPrefill(new URLSearchParams({ kids: "many" }), [number]).extras
        .kids,
    ).toBeUndefined();
  });

  it("keeps only an ISO date the date input can render", () => {
    expect(
      parseSignupPrefill(new URLSearchParams({ born: "1990-04-01" }), [date])
        .extras.born,
    ).toBe("1990-04-01");
    expect(
      parseSignupPrefill(new URLSearchParams({ born: "01/04/1990" }), [date])
        .extras.born,
    ).toBeUndefined();
  });

  it("ignores params with no matching field definition", () => {
    const result = parseSignupPrefill(
      new URLSearchParams({ unknown_field: "value" }),
      [text],
    );
    expect(result.extras).toEqual({});
  });
});

describe("parseSignupPrefill — plain searchParams objects", () => {
  it("accepts the object shape Next hands a page", () => {
    const result = parseSignupPrefill(
      { firstName: "Ada", profession: "engineer" },
      [text],
    );
    expect(result.firstName).toBe("Ada");
    expect(result.extras.profession).toBe("engineer");
  });

  it("takes the first value of a repeated param", () => {
    const result = parseSignupPrefill({ firstName: ["Ada", "Grace"] }, []);
    expect(result.firstName).toBe("Ada");
  });

  it("ignores undefined values", () => {
    const result = parseSignupPrefill({ firstName: undefined }, []);
    expect(result.firstName).toBe("");
  });
});
