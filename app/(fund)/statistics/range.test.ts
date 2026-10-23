// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RANGE,
  RANGE_PRESETS,
  isRangePreset,
  resolveRangeWindow,
} from "./range";

// Mid-month, mid-day "now" so no preset sits on a boundary by accident. All
// expectations are built with the local-time constructor, matching the
// module's local-clock semantics whatever TZ the test runner has.
const NOW = new Date(2026, 9, 23, 15, 30); // 23 Oct 2026, 15:30 local

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe("isRangePreset", () => {
  it("accepts every preset and rejects anything else", () => {
    for (const p of RANGE_PRESETS) expect(isRangePreset(p)).toBe(true);
    expect(isRangePreset(undefined)).toBe(false);
    expect(isRangePreset("")).toBe(false);
    expect(isRangePreset("last30")).toBe(false);
  });

  it("defaults to all time", () => {
    expect(DEFAULT_RANGE).toBe("all");
  });
});

describe("resolveRangeWindow", () => {
  it("all is unbounded on both ends", () => {
    expect(resolveRangeWindow("all", "2026-01-01", "2026-02-01", NOW)).toEqual({
      from: null,
      to: null,
    });
  });

  it("thisMonth is [1st of this month, 1st of next)", () => {
    expect(resolveRangeWindow("thisMonth", undefined, undefined, NOW)).toEqual({
      from: local(2026, 10, 1),
      to: local(2026, 11, 1),
    });
  });

  it("lastMonth is [1st of last month, 1st of this)", () => {
    expect(resolveRangeWindow("lastMonth", undefined, undefined, NOW)).toEqual({
      from: local(2026, 9, 1),
      to: local(2026, 10, 1),
    });
  });

  it("lastMonth in January rolls back into December of last year", () => {
    expect(
      resolveRangeWindow("lastMonth", undefined, undefined, new Date(2027, 0, 10)),
    ).toEqual({ from: local(2026, 12, 1), to: local(2027, 1, 1) });
  });

  it("thisYear is [1 Jan, 1 Jan next year)", () => {
    expect(resolveRangeWindow("thisYear", undefined, undefined, NOW)).toEqual({
      from: local(2026, 1, 1),
      to: local(2027, 1, 1),
    });
  });

  it("lastYear is [1 Jan last year, 1 Jan this year)", () => {
    expect(resolveRangeWindow("lastYear", undefined, undefined, NOW)).toEqual({
      from: local(2025, 1, 1),
      to: local(2026, 1, 1),
    });
  });

  it("custom treats `to` as an inclusive day", () => {
    expect(resolveRangeWindow("custom", "2026-03-05", "2026-03-31", NOW)).toEqual({
      from: local(2026, 3, 5),
      to: local(2026, 4, 1),
    });
  });

  it("custom swaps days given the wrong way round", () => {
    expect(resolveRangeWindow("custom", "2026-03-31", "2026-03-05", NOW)).toEqual({
      from: local(2026, 3, 5),
      to: local(2026, 4, 1),
    });
  });

  it("custom with a missing end is open on that side", () => {
    expect(resolveRangeWindow("custom", "2026-03-05", undefined, NOW)).toEqual({
      from: local(2026, 3, 5),
      to: null,
    });
    expect(resolveRangeWindow("custom", undefined, "2026-03-05", NOW)).toEqual({
      from: null,
      to: local(2026, 3, 6),
    });
    expect(resolveRangeWindow("custom", undefined, undefined, NOW)).toEqual({
      from: null,
      to: null,
    });
  });

  it("custom ignores malformed days", () => {
    expect(resolveRangeWindow("custom", "05/03/2026", "2026-3-31", NOW)).toEqual({
      from: null,
      to: null,
    });
    expect(resolveRangeWindow("custom", "yesterday", "", NOW)).toEqual({
      from: null,
      to: null,
    });
  });
});
