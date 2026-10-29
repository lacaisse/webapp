// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { AttemptLimiter } from "./attempt-limiter";

describe("AttemptLimiter", () => {
  it("locks a key after `max` failures inside the window and frees it after", () => {
    const l = new AttemptLimiter(3, 1_000);
    const t0 = 10_000;
    expect(l.allowed("u", t0)).toBe(true);
    l.fail("u", t0);
    l.fail("u", t0 + 100);
    expect(l.allowed("u", t0 + 200)).toBe(true);
    l.fail("u", t0 + 200);
    expect(l.allowed("u", t0 + 300)).toBe(false);
    // The oldest failure slides out of the window.
    expect(l.allowed("u", t0 + 1_001)).toBe(true);
  });

  it("keeps keys apart and resets on success", () => {
    const l = new AttemptLimiter(1, 1_000);
    l.fail("a", 0);
    expect(l.allowed("a", 1)).toBe(false);
    expect(l.allowed("b", 1)).toBe(true);
    l.reset("a");
    expect(l.allowed("a", 2)).toBe(true);
  });
});
