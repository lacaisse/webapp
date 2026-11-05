// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isUniqueViolationOn } from "./unique-violation";

// The three places Prisma has put the violated unique's name in — the member
// sign-up (and soon fund creation) answers "taken" from it.
function p2002(extra: { message?: string; meta?: unknown }) {
  return Object.assign(new Error(extra.message ?? "Unique constraint failed"), {
    code: "P2002",
    meta: extra.meta,
  });
}

describe("isUniqueViolationOn", () => {
  it("reads the classic engine's meta.target, as a column list or a constraint name", () => {
    expect(isUniqueViolationOn(p2002({ meta: { target: ["email"] } }), "email")).toBe(true);
    expect(isUniqueViolationOn(p2002({ meta: { target: "Fund_domain_key" } }), "domain")).toBe(true);
    expect(isUniqueViolationOn(p2002({ meta: { target: ["email"] } }), "domain")).toBe(false);
  });

  it("reads a driver adapter's cause.constraint (Prisma 7 + @prisma/adapter-pg)", () => {
    const fields = p2002({
      meta: {
        modelName: "User",
        driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { fields: ["email"] } } },
      },
    });
    expect(isUniqueViolationOn(fields, "email")).toBe(true);
    expect(isUniqueViolationOn(fields, "domain")).toBe(false);
    const index = p2002({
      meta: {
        modelName: "Fund",
        driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index: "Fund_domain_key" } } },
      },
    });
    expect(isUniqueViolationOn(index, "domain")).toBe(true);
  });

  it("falls back to the message when meta names nothing", () => {
    expect(
      isUniqueViolationOn(
        p2002({ message: "Invalid `tx.user.create()` invocation\n\nUnique constraint failed on the constraint: `User_email_key`", meta: { modelName: "User" } }),
        "email",
      ),
    ).toBe(true);
    expect(
      isUniqueViolationOn(
        p2002({ message: "Unique constraint failed on the fields: (`fundId`,`paymentReference`)", meta: {} }),
        "paymentReference",
      ),
    ).toBe(true);
    expect(
      isUniqueViolationOn(p2002({ message: "Unique constraint failed on the constraint: `User_email_key`" }), "domain"),
    ).toBe(false);
  });

  it("is false for anything that is not a P2002", () => {
    expect(isUniqueViolationOn(new Error("Unique constraint failed on the fields: (`email`)"), "email")).toBe(false);
    expect(isUniqueViolationOn(Object.assign(new Error("x"), { code: "P2025" }), "email")).toBe(false);
    expect(isUniqueViolationOn(null, "email")).toBe(false);
  });
});
