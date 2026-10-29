// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { blockingSafes, type SafeSignerShape } from "./guardrails-rule";

const admins = new Set(["a", "b", "c"]);
const safe = (threshold: number, owners: SafeSignerShape["owners"]): SafeSignerShape => ({
  id: "s",
  name: "Reserve",
  threshold,
  owners,
});
const member = (userId: string) => ({ kind: "MEMBER" as const, userId });
const external = { kind: "EXTERNAL" as const, userId: null };

describe("blockingSafes", () => {
  it("blocks when the remaining admins + externals fall below the threshold", () => {
    expect(blockingSafes([safe(2, [member("a"), member("b")])], "a", admins)).toEqual([
      { id: "s", name: "Reserve" },
    ]);
  });

  it("allows when enough other admins or externals remain", () => {
    expect(blockingSafes([safe(2, [member("a"), member("b"), member("c")])], "a", admins)).toEqual([]);
    expect(blockingSafes([safe(2, [member("a"), member("b"), external])], "a", admins)).toEqual([]);
    expect(blockingSafes([safe(1, [member("a"), external])], "a", admins)).toEqual([]);
  });

  it("does not count members who are no longer admins", () => {
    expect(blockingSafes([safe(2, [member("a"), member("b"), member("z")])], "a", admins)).toEqual([
      { id: "s", name: "Reserve" },
    ]);
  });
});
