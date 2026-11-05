// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { AcceptSubscriptionSchema, normaliseVatNumber, type AcceptSubscriptionInput } from "./schema";

const VALID: AcceptSubscriptionInput = {
  legalName: "La Caisse de Saint-Gilles ASBL",
  email: "treasurer@example.org",
  address: "Rue de la Victoire 1\n1060 Saint-Gilles",
  vatNumber: "BE0123456789",
  accepted: true,
};

function errorsOf(input: Partial<Record<keyof AcceptSubscriptionInput, unknown>>) {
  const result = AcceptSubscriptionSchema.safeParse({ ...VALID, ...input });
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe("normaliseVatNumber", () => {
  it("uppercases and removes spaces, dots and dashes", () => {
    expect(normaliseVatNumber("be 0123.456.789")).toBe("BE0123456789");
    expect(normaliseVatNumber("fr-12 345")).toBe("FR12345");
  });
});

describe("AcceptSubscriptionSchema", () => {
  it("accepts a valid submission and normalises the VAT number", () => {
    const parsed = AcceptSubscriptionSchema.parse({ ...VALID, vatNumber: "be 0123.456.789" });
    expect(parsed.vatNumber).toBe("BE0123456789");
  });

  it("accepts an empty VAT number", () => {
    expect(AcceptSubscriptionSchema.parse({ ...VALID, vatNumber: "" }).vatNumber).toBe("");
    expect(AcceptSubscriptionSchema.parse({ ...VALID, vatNumber: "  " }).vatNumber).toBe("");
  });

  it("rejects a malformed VAT number", () => {
    expect(errorsOf({ vatNumber: "0123456789" })).toEqual([
      "fund.settings.subscription.errors.vatInvalid",
    ]);
    expect(errorsOf({ vatNumber: "BE!" })).toEqual(["fund.settings.subscription.errors.vatInvalid"]);
  });

  it("requires the acceptance box", () => {
    expect(errorsOf({ accepted: false })).toEqual(["fund.settings.subscription.errors.mustAccept"]);
  });

  it("trims and lowercases the email", () => {
    expect(AcceptSubscriptionSchema.parse({ ...VALID, email: "  Treasurer@Example.ORG " }).email).toBe(
      "treasurer@example.org",
    );
  });

  it("rejects an invalid email", () => {
    expect(errorsOf({ email: "not-an-email" })).toEqual([
      "fund.settings.subscription.errors.emailInvalid",
    ]);
  });

  it("bounds the legal name and the address", () => {
    expect(errorsOf({ legalName: " A " })).toEqual(["fund.settings.subscription.errors.legalNameMin"]);
    expect(errorsOf({ legalName: "x".repeat(201) })).toEqual([
      "fund.settings.subscription.errors.legalNameMax",
    ]);
    expect(errorsOf({ address: "abc" })).toEqual(["fund.settings.subscription.errors.addressMin"]);
    expect(errorsOf({ address: "x".repeat(501) })).toEqual([
      "fund.settings.subscription.errors.addressMax",
    ]);
  });
});
