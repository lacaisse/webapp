// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { REAUTH_REQUIRED, isReauthRequired, type ReauthRequiredError } from "./step-up-types";

describe("isReauthRequired", () => {
  it("recognises the step-up refusal of a server action", () => {
    expect(isReauthRequired({ error: "Confirm it's you", code: REAUTH_REQUIRED })).toBe(true);
  });

  it("ignores successes and ordinary errors", () => {
    expect(isReauthRequired({ ok: true })).toBe(false);
    expect(isReauthRequired({ error: "Amount invalid" })).toBe(false);
    expect(isReauthRequired({ error: "Not found", code: "not_found" })).toBe(false);
  });

  it("looks at the code alone, whatever else the result carries", () => {
    expect(isReauthRequired({ ok: true, code: "reauth_required" })).toBe(true);
    expect(isReauthRequired({ error: "x", code: undefined })).toBe(false);
    expect(isReauthRequired({})).toBe(false);
  });

  it("narrows the result so a caller can keep using the other shapes", () => {
    type Result = { ok: true; txHash: string } | { error: string; field?: "amount" } | ReauthRequiredError;
    const res: Result = { error: "Amount invalid", field: "amount" };
    if (isReauthRequired(res)) throw new Error("not expected");
    // `field` is only reachable once the refusal is excluded — a compile-time
    // check as much as a runtime one.
    expect("field" in res ? res.field : null).toBe("amount");
  });
});
