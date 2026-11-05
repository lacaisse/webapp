// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  AcceptSubscriptionSchema,
  CreateWaiverCodeSchema,
  JoinSchema,
  PASSWORD_MIN_LENGTH,
  RedeemWaiverCodeSchema,
  WAIVER_EXPIRES_DAYS_MAX,
  WAIVER_LABEL_MAX,
  WAIVER_MAX_USES_MAX,
  normaliseVatNumber,
  type AcceptSubscriptionInput,
} from "./schema";

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

describe("RedeemWaiverCodeSchema", () => {
  it("normalises what a person typed and keeps a well-formed code", () => {
    const parsed = RedeemWaiverCodeSchema.safeParse({ code: " 7k3p-m2qx 9rtd " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.code).toBe("7K3PM2QX9RTD");
  });

  it("maps the look-alike letters the alphabet left out", () => {
    const parsed = RedeemWaiverCodeSchema.safeParse({ code: "OIL1-2345-6789" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.code).toBe("011123456789");
  });

  it("refuses an empty code with its own message", () => {
    const parsed = RedeemWaiverCodeSchema.safeParse({ code: " -- " });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("fund.settings.subscription.errors.codeRequired");
    }
  });

  it("refuses the wrong length or a letter outside the alphabet", () => {
    for (const code of ["7K3P-M2QX", "7K3P-M2QX-9RTD-AAAA", "7K3P-M2QX-9RTU"]) {
      const parsed = RedeemWaiverCodeSchema.safeParse({ code });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toBe("fund.settings.subscription.errors.codeInvalid");
      }
    }
  });
});

describe("CreateWaiverCodeSchema", () => {
  const valid = { label: "  Contributor: Alice ", maxUses: 1, expiresInDays: null };

  it("trims the label and accepts a code without expiry", () => {
    const parsed = CreateWaiverCodeSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.label).toBe("Contributor: Alice");
      expect(parsed.data.expiresInDays).toBeNull();
    }
  });

  it("bounds the label length", () => {
    expect(CreateWaiverCodeSchema.safeParse({ ...valid, label: "A" }).success).toBe(false);
    expect(
      CreateWaiverCodeSchema.safeParse({ ...valid, label: "A".repeat(WAIVER_LABEL_MAX + 1) }).success,
    ).toBe(false);
  });

  it("wants whole numbers inside the ranges", () => {
    for (const maxUses of [0, 1.5, Number.NaN, WAIVER_MAX_USES_MAX + 1]) {
      const parsed = CreateWaiverCodeSchema.safeParse({ ...valid, maxUses });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0].message).toBe("admin.waivers.errors.maxUsesRange");
    }
    for (const expiresInDays of [0, 2.5, WAIVER_EXPIRES_DAYS_MAX + 1]) {
      const parsed = CreateWaiverCodeSchema.safeParse({ ...valid, expiresInDays });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0].message).toBe("admin.waivers.errors.expiresRange");
    }
    expect(CreateWaiverCodeSchema.safeParse({ ...valid, maxUses: 25, expiresInDays: 30 }).success).toBe(true);
  });
});

describe("JoinSchema", () => {
  const VALID = {
    code: "7k3p-m2qx-9rtd",
    email: " Alice@Example.org ",
    password: "x".repeat(PASSWORD_MIN_LENGTH),
    name: "La Class",
    subdomain: "laclass",
  };
  const firstError = (input: Partial<typeof VALID>) => {
    const result = JoinSchema.safeParse({ ...VALID, ...input });
    return result.success ? null : result.error.issues[0];
  };

  it("normalises the code and stores the email lowercase and trimmed", () => {
    const parsed = JoinSchema.parse(VALID);
    expect(parsed.code).toBe("7K3PM2QX9RTD");
    expect(parsed.email).toBe("alice@example.org");
    expect(parsed).toMatchObject({ name: "La Class", subdomain: "laclass" });
  });

  it("takes no code at all: absent, empty or only separators mean none", () => {
    const { email, password, name, subdomain } = VALID;
    expect(JoinSchema.parse({ email, password, name, subdomain }).code).toBeUndefined();
    expect(JoinSchema.parse({ ...VALID, code: "" }).code).toBeUndefined();
    expect(JoinSchema.parse({ ...VALID, code: " - " }).code).toBeUndefined();
  });

  it("uses the public door's words for a code that has no code's shape", () => {
    expect(firstError({ code: "7K3P-M2QX" })).toMatchObject({ path: ["code"], message: "join.errors.codeInvalid" });
  });

  it("applies the auth host's account rules and /new's fund rules", () => {
    expect(firstError({ email: "nope" })).toMatchObject({ path: ["email"], message: "auth.errors.emailInvalid" });
    expect(firstError({ password: "x".repeat(PASSWORD_MIN_LENGTH - 1) })).toMatchObject({
      path: ["password"],
      message: "auth.errors.passwordMin",
    });
    expect(firstError({ name: "A" })).toMatchObject({ path: ["name"], message: "funds.create.errors.nameMin" });
    expect(firstError({ subdomain: "admin" })).toMatchObject({
      path: ["subdomain"],
      message: "funds.create.errors.subdomainReserved",
    });
    expect(firstError({ subdomain: "Not Valid" })).toMatchObject({
      path: ["subdomain"],
      message: "funds.create.errors.subdomainFormat",
    });
  });
});
