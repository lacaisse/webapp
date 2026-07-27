// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  isEmptyAnswer,
  mergeApplicationData,
  normalizeAnswer,
} from "./application-data";

describe("mergeApplicationData — editing what the form shows", () => {
  it("updates an answer the form asked about", () => {
    const result = mergeApplicationData({ profession: "Baker" }, ["profession"], {
      profession: "Engineer",
    });
    expect(result).toEqual({ profession: "Engineer" });
  });

  it("adds an answer that wasn't there before", () => {
    const result = mergeApplicationData({}, ["profession"], {
      profession: "Engineer",
    });
    expect(result).toEqual({ profession: "Engineer" });
  });

  it("trims a submitted string", () => {
    const result = mergeApplicationData({}, ["city"], { city: "  Ghent " });
    expect(result).toEqual({ city: "Ghent" });
  });
});

describe("mergeApplicationData — clearing", () => {
  it("removes the key entirely rather than storing an empty string", () => {
    // One representation of "unanswered" keeps every downstream reader simple.
    const result = mergeApplicationData({ profession: "Baker" }, ["profession"], {
      profession: "",
    });
    expect(result).toEqual({});
    expect("profession" in result).toBe(false);
  });

  it("removes a key when its field is submitted as undefined", () => {
    const result = mergeApplicationData({ profession: "Baker" }, ["profession"], {});
    expect(result).toEqual({});
  });

  it("removes an emptied multi-select and an unticked checkbox", () => {
    const result = mergeApplicationData(
      { days: ["mon"], newsletter: true },
      ["days", "newsletter"],
      { days: [], newsletter: false },
    );
    expect(result).toEqual({});
  });
});

describe("mergeApplicationData — answers the form never showed", () => {
  it("preserves an answer to an archived question", () => {
    // The whole reason this helper exists: saving the edit form must not wipe
    // history for a question the fund stopped asking.
    const result = mergeApplicationData(
      { profession: "Baker", oldSurvey: "yes" },
      ["profession"],
      { profession: "Engineer" },
    );
    expect(result).toEqual({ profession: "Engineer", oldSurvey: "yes" });
  });

  it("preserves untouched answers even when everything editable is cleared", () => {
    const result = mergeApplicationData(
      { archivedNote: "keep me", profession: "Baker" },
      ["profession"],
      { profession: "" },
    );
    expect(result).toEqual({ archivedNote: "keep me" });
  });

  it("ignores submitted keys that aren't editable", () => {
    // Defensive against a tampered payload naming a field the fund doesn't ask.
    const result = mergeApplicationData({}, ["profession"], {
      profession: "Engineer",
      injected: "nope",
    });
    expect(result).toEqual({ profession: "Engineer" });
  });

  it("does not mutate the object it was given", () => {
    const existing = { profession: "Baker" };
    mergeApplicationData(existing, ["profession"], { profession: "Engineer" });
    expect(existing).toEqual({ profession: "Baker" });
  });
});

describe("isEmptyAnswer", () => {
  it("treats blank, whitespace, empty arrays, false and absent as empty", () => {
    for (const v of ["", "   ", [], false, undefined]) {
      expect(isEmptyAnswer(v as never)).toBe(true);
    }
  });

  it("treats real answers as non-empty", () => {
    for (const v of ["x", ["a"], true]) {
      expect(isEmptyAnswer(v as never)).toBe(false);
    }
  });
});

describe("normalizeAnswer", () => {
  it("trims strings and drops blank array entries", () => {
    expect(normalizeAnswer("  hi ")).toBe("hi");
    expect(normalizeAnswer([" a ", "", " b"])).toEqual(["a", "b"]);
  });

  it("passes booleans through", () => {
    expect(normalizeAnswer(true)).toBe(true);
  });
});
