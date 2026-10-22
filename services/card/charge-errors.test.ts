// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  CHARGE_IDEMPOTENCY_KEY_RE,
  chargeErrorKey,
  newChargeIdempotencyKey,
  parseAmountCents,
} from "./charge-errors";

describe("chargeErrorKey", () => {
  it("maps the api's sentences, whatever their case or padding", () => {
    expect(chargeErrorKey("invalid card pin")).toBe(
      "cards.admin.charge.errors.pinInvalid",
    );
    expect(chargeErrorKey("  Insufficient Card Balance ")).toBe(
      "cards.admin.charge.errors.insufficient",
    );
    expect(chargeErrorKey("badge lost")).toBe(
      "cards.admin.charge.errors.badgeLost",
    );
  });

  it("leaves an unknown sentence to be shown as sent", () => {
    expect(
      chargeErrorKey("order is checkout and cannot be charged"),
    ).toBeNull();
    expect(chargeErrorKey("charge failed: rpc down")).toBeNull();
    expect(chargeErrorKey("")).toBeNull();
  });
});

describe("parseAmountCents", () => {
  it("reads a positive amount with up to two decimals, dot or comma", () => {
    expect(parseAmountCents("12.50")).toBe(1250);
    expect(parseAmountCents("12,5")).toBe(1250);
    expect(parseAmountCents(" 12 ")).toBe(1200);
    expect(parseAmountCents("0.01")).toBe(1);
  });

  it("refuses anything else", () => {
    expect(parseAmountCents("0")).toBeNull();
    expect(parseAmountCents("-1")).toBeNull();
    expect(parseAmountCents("1.234")).toBeNull();
    expect(parseAmountCents("1.000,00")).toBeNull();
    expect(parseAmountCents("abc")).toBeNull();
    expect(parseAmountCents("")).toBeNull();
  });
});

describe("newChargeIdempotencyKey", () => {
  it("fits the api's shape and differs per call", () => {
    const a = newChargeIdempotencyKey();
    const b = newChargeIdempotencyKey();
    expect(a).toMatch(CHARGE_IDEMPOTENCY_KEY_RE);
    expect(b).toMatch(CHARGE_IDEMPOTENCY_KEY_RE);
    expect(a).not.toBe(b);
  });
});
