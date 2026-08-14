// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { buildExtrasSchema, type ExtraFieldDef } from "./extras-schema";

const def = (
  key: string,
  type: ExtraFieldDef["type"],
  required: boolean,
): ExtraFieldDef => ({ key, type, required });

function firstErrorKey(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? null : result.error!.issues[0].message;
}

describe("buildExtrasSchema — required text", () => {
  const schema = buildExtrasSchema([def("profession", "TEXT", true)]);

  it("accepts a non-empty answer", () => {
    expect(schema.safeParse({ profession: "engineer" }).success).toBe(true);
  });

  it("rejects an empty answer with the required key", () => {
    expect(firstErrorKey(schema.safeParse({ profession: "" }))).toBe(
      "members.signup.errors.required",
    );
  });

  it("rejects a whitespace-only answer", () => {
    expect(schema.safeParse({ profession: "   " }).success).toBe(false);
  });
});

describe("buildExtrasSchema — optional fields", () => {
  const schema = buildExtrasSchema([def("profession", "TEXT", false)]);

  it("accepts an empty answer", () => {
    expect(schema.safeParse({ profession: "" }).success).toBe(true);
  });

  it("accepts a missing key", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe("buildExtrasSchema — required checkbox", () => {
  const schema = buildExtrasSchema([def("consent", "CHECKBOX", true)]);

  it("accepts a ticked box", () => {
    expect(schema.safeParse({ consent: true }).success).toBe(true);
  });

  it("rejects an unticked box — it is a consent gate", () => {
    expect(schema.safeParse({ consent: false }).success).toBe(false);
  });
});

describe("buildExtrasSchema — required multiselect", () => {
  const schema = buildExtrasSchema([def("days", "MULTISELECT", true)]);

  it("accepts at least one selection", () => {
    expect(schema.safeParse({ days: ["mon"] }).success).toBe(true);
  });

  it("rejects an empty selection", () => {
    expect(firstErrorKey(schema.safeParse({ days: [] }))).toBe(
      "members.signup.errors.required",
    );
  });
});

describe("buildExtrasSchema — email fields", () => {
  it("requires a valid address when required", () => {
    const schema = buildExtrasSchema([def("work", "EMAIL", true)]);
    expect(schema.safeParse({ work: "a@b.org" }).success).toBe(true);
    expect(schema.safeParse({ work: "nope" }).success).toBe(false);
    expect(firstErrorKey(schema.safeParse({ work: "" }))).toBe(
      "members.signup.errors.required",
    );
  });

  it("allows blank but rejects malformed when optional", () => {
    const schema = buildExtrasSchema([def("work", "EMAIL", false)]);
    expect(schema.safeParse({ work: "" }).success).toBe(true);
    expect(schema.safeParse({ work: "a@b.org" }).success).toBe(true);
    expect(schema.safeParse({ work: "nope" }).success).toBe(false);
  });
});

describe("buildExtrasSchema — no fields", () => {
  it("accepts an empty object", () => {
    expect(buildExtrasSchema([]).safeParse({}).success).toBe(true);
  });
});

describe("buildExtrasSchema — conditional required (visibleIf)", () => {
  const fields: ExtraFieldDef[] = [
    def("householdAdults", "NUMBER", false),
    {
      ...def("householdincome", "TEXT", true),
      visibleIf: { fieldKey: "householdAdults", operator: "gt", value: "1" },
    },
  ];
  const schema = buildExtrasSchema(fields);

  it("does not require the dependent field while hidden", () => {
    expect(
      schema.safeParse({ householdAdults: "1", householdincome: "" }).success,
    ).toBe(true);
    expect(schema.safeParse({ householdAdults: "1" }).success).toBe(true);
  });

  it("requires it once the condition is met", () => {
    const result = schema.safeParse({
      householdAdults: "2",
      householdincome: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["householdincome"]);
      expect(result.error.issues[0].message).toBe(
        "members.signup.errors.required",
      );
    }
  });

  it("accepts an answer once visible", () => {
    expect(
      schema.safeParse({ householdAdults: "2", householdincome: "3000" })
        .success,
    ).toBe(true);
  });
});
