// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isFieldVisible, parseVisibleIf, type VisibleIf } from "./visibility";

describe("isFieldVisible — no rule", () => {
  it("is always visible", () => {
    expect(isFieldVisible(null, {})).toBe(true);
    expect(isFieldVisible(undefined, {})).toBe(true);
  });
});

describe("isFieldVisible — numeric operators", () => {
  const gt1: VisibleIf = { fieldKey: "householdAdults", operator: "gt", value: "1" };

  it("shows the field once the dependency exceeds the threshold", () => {
    expect(isFieldVisible(gt1, { householdAdults: "2" })).toBe(true);
  });

  it("hides the field at or below the threshold", () => {
    expect(isFieldVisible(gt1, { householdAdults: "1" })).toBe(false);
    expect(isFieldVisible(gt1, { householdAdults: "0" })).toBe(false);
  });

  it("hides the field when the dependency is unanswered", () => {
    expect(isFieldVisible(gt1, {})).toBe(false);
  });

  it("hides the field when the dependency isn't numeric", () => {
    expect(isFieldVisible(gt1, { householdAdults: "abc" })).toBe(false);
  });

  it("supports gte/lt/lte", () => {
    const gte2: VisibleIf = { fieldKey: "n", operator: "gte", value: "2" };
    expect(isFieldVisible(gte2, { n: "2" })).toBe(true);
    expect(isFieldVisible(gte2, { n: "1" })).toBe(false);

    const lt2: VisibleIf = { fieldKey: "n", operator: "lt", value: "2" };
    expect(isFieldVisible(lt2, { n: "1" })).toBe(true);
    expect(isFieldVisible(lt2, { n: "2" })).toBe(false);

    const lte2: VisibleIf = { fieldKey: "n", operator: "lte", value: "2" };
    expect(isFieldVisible(lte2, { n: "2" })).toBe(true);
    expect(isFieldVisible(lte2, { n: "3" })).toBe(false);
  });
});

describe("isFieldVisible — eq/neq", () => {
  const eq: VisibleIf = { fieldKey: "plan", operator: "eq", value: "family" };

  it("compares strings directly", () => {
    expect(isFieldVisible(eq, { plan: "family" })).toBe(true);
    expect(isFieldVisible(eq, { plan: "solo" })).toBe(false);
  });

  it("treats a checkbox answer as true/false", () => {
    const consented: VisibleIf = { fieldKey: "consent", operator: "eq", value: "true" };
    expect(isFieldVisible(consented, { consent: true })).toBe(true);
    expect(isFieldVisible(consented, { consent: false })).toBe(false);
  });

  it("neq is the inverse", () => {
    const neq: VisibleIf = { ...eq, operator: "neq" };
    expect(isFieldVisible(neq, { plan: "family" })).toBe(false);
    expect(isFieldVisible(neq, { plan: "solo" })).toBe(true);
  });
});

describe("parseVisibleIf", () => {
  it("passes through a valid rule", () => {
    const raw = { fieldKey: "householdAdults", operator: "gt", value: "1" };
    expect(parseVisibleIf(raw)).toEqual(raw);
  });

  it("degrades malformed data to null instead of throwing", () => {
    expect(parseVisibleIf({ fieldKey: "x" })).toBeNull();
    expect(parseVisibleIf("not an object")).toBeNull();
    expect(parseVisibleIf(null)).toBeNull();
    expect(parseVisibleIf(undefined)).toBeNull();
  });
});
