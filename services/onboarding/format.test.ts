// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { formatOnboardingAnswer, type AnswerFormatters } from "./format";

// Stand-in for what the detail pages inject from next-intl.
const fmt: AnswerFormatters = {
  boolean: (v) => (v ? "Oui" : "Non"),
  date: (v) => `le ${v}`,
};

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

  it("resolves a lone string answer rather than rendering it raw", () => {
    expect(formatOnboardingAnswer("b", field)).toBe("Option B");
  });

  it("reads an emptied selection as unanswered, not as a blank cell", () => {
    expect(formatOnboardingAnswer([], field)).toBe("—");
  });
});

describe("formatOnboardingAnswer — CHECKBOX", () => {
  const field = { type: "CHECKBOX" as const, options: [] };

  it("localizes both states through the injected formatter", () => {
    expect(formatOnboardingAnswer(true, field, fmt)).toBe("Oui");
    expect(formatOnboardingAnswer(false, field, fmt)).toBe("Non");
  });

  it("falls back to the raw boolean without a formatter", () => {
    expect(formatOnboardingAnswer(true, field)).toBe("true");
  });

  it("localizes a stray boolean even when the field type has since changed", () => {
    expect(
      formatOnboardingAnswer(true, { type: "TEXT", options: [] }, fmt),
    ).toBe("Oui");
  });
});

describe("formatOnboardingAnswer — DATE", () => {
  const field = { type: "DATE" as const, options: [] };

  it("formats a well-formed date through the injected formatter", () => {
    expect(formatOnboardingAnswer("2026-08-17", field, fmt)).toBe(
      "le 2026-08-17",
    );
  });

  it("leaves a malformed date as stored rather than rendering Invalid Date", () => {
    expect(formatOnboardingAnswer("17/08/2026", field, fmt)).toBe("17/08/2026");
    expect(formatOnboardingAnswer("2026-13-45", field, fmt)).toBe("2026-13-45");
  });

  it("returns the raw value without a formatter", () => {
    expect(formatOnboardingAnswer("2026-08-17", field)).toBe("2026-08-17");
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
