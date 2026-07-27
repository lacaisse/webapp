// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { buildFormSteps, type FieldWithStep, type StepDef } from "./form-steps";

const step = (id: string, position: number, title = id): StepDef => ({
  id,
  title,
  description: null,
  position,
});

const field = (
  key: string,
  position: number,
  stepId: string | null = null,
): FieldWithStep => ({ key, position, stepId });

describe("buildFormSteps — no steps configured", () => {
  it("returns a single anonymous page holding every field", () => {
    const result = buildFormSteps([], [field("b", 1), field("a", 0)]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBeNull();
    expect(result[0].title).toBeNull();
    expect(result[0].fields.map((f) => f.key)).toEqual(["a", "b"]);
  });

  it("returns one empty page when the fund has no fields either", () => {
    const result = buildFormSteps([], []);
    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual([]);
  });
});

describe("buildFormSteps — grouping", () => {
  it("orders pages by position and fields by position within a page", () => {
    const steps = [step("s2", 1), step("s1", 0)];
    const fields = [
      field("second", 1, "s1"),
      field("first", 0, "s1"),
      field("later", 0, "s2"),
    ];
    const result = buildFormSteps(steps, fields);
    expect(result.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(result[0].fields.map((f) => f.key)).toEqual(["first", "second"]);
    expect(result[1].fields.map((f) => f.key)).toEqual(["later"]);
  });

  it("carries the step title and description through", () => {
    const result = buildFormSteps(
      [{ id: "s1", title: "About you", description: "Tell us more", position: 0 }],
      [],
    );
    expect(result[0].title).toBe("About you");
    expect(result[0].description).toBe("Tell us more");
  });

  it("leaves a page with no assigned fields empty rather than dropping it", () => {
    const result = buildFormSteps(
      [step("s1", 0), step("s2", 1)],
      [field("only", 0, "s1")],
    );
    expect(result).toHaveLength(2);
    expect(result[1].fields).toEqual([]);
  });
});

describe("buildFormSteps — fallback to the first page", () => {
  it("puts unassigned fields on the first page", () => {
    const result = buildFormSteps(
      [step("s1", 0), step("s2", 1)],
      [field("loose", 0, null)],
    );
    expect(result[0].fields.map((f) => f.key)).toEqual(["loose"]);
    expect(result[1].fields).toEqual([]);
  });

  it("rescues a field pointing at a step that is gone or archived", () => {
    const result = buildFormSteps(
      [step("s1", 0), step("s2", 1)],
      [field("orphan", 0, "archived-step")],
    );
    expect(result[0].fields.map((f) => f.key)).toEqual(["orphan"]);
  });

  it("uses the lowest-position step as the fallback, not the input order", () => {
    const result = buildFormSteps(
      [step("late", 5), step("early", 0)],
      [field("orphan", 0, null)],
    );
    expect(result[0].id).toBe("early");
    expect(result[0].fields.map((f) => f.key)).toEqual(["orphan"]);
  });

  it("never loses a field", () => {
    const fields = [
      field("a", 0, "s1"),
      field("b", 1, null),
      field("c", 2, "gone"),
      field("d", 3, "s2"),
    ];
    const result = buildFormSteps([step("s1", 0), step("s2", 1)], fields);
    const placed = result.flatMap((s) => s.fields.map((f) => f.key));
    expect(placed.sort()).toEqual(["a", "b", "c", "d"]);
  });
});
