// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { formatOnboardingAnswer } from "./format";

describe("formatOnboardingAnswer — SELECT", () => {
  const field = {
    type: "SELECT" as const,
    options: [
      { value: "value1", label: "75 €" },
      { value: "value2", label: "150 €" },
    ],
  };

  it("resolves the stored value to its label", () => {
    expect(formatOnboardingAnswer("value1", field)).toBe("75 €");
  });

  it("falls back to the raw value when no option matches", () => {
    expect(formatOnboardingAnswer("value3", field)).toBe("value3");
  });

  it("renders an empty dash for a blank answer", () => {
    expect(formatOnboardingAnswer("", field)).toBe("—");
    expect(formatOnboardingAnswer(null, field)).toBe("—");
  });
});

describe("formatOnboardingAnswer — MULTISELECT", () => {
  const field = {
    type: "MULTISELECT" as const,
    options: [
      { value: "a", label: "Option A" },
      { value: "b", label: "Option B" },
    ],
  };

  it("resolves every selected value to its label", () => {
    expect(formatOnboardingAnswer(["a", "b"], field)).toBe(
      "Option A, Option B",
    );
  });

  it("falls back to the raw value for unmatched entries", () => {
    expect(formatOnboardingAnswer(["a", "c"], field)).toBe("Option A, c");
  });
});

describe("formatOnboardingAnswer — plain types", () => {
  it("joins arrays without a field definition", () => {
    expect(formatOnboardingAnswer(["x", "y"], undefined)).toBe("x, y");
  });

  it("stringifies scalars", () => {
    expect(
      formatOnboardingAnswer("hello", { type: "TEXT", options: [] }),
    ).toBe("hello");
  });
});
