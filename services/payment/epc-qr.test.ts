// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { buildEpcQrPayload } from "./epc-qr";

describe("buildEpcQrPayload", () => {
  it("emits the BCD fields in the spec order", () => {
    const payload = buildEpcQrPayload({
      beneficiary: "La CLASS ASBL",
      iban: "BE82 1036 0037 1868",
      amount: 150,
      reference: "ABCD2345",
    });

    expect(payload).toBe(
      [
        "BCD",
        "002",
        "1",
        "SCT",
        "",
        "La CLASS ASBL",
        "BE82103600371868",
        "EUR150.00",
        "",
        "",
        "ABCD2345",
      ].join("\n"),
    );
  });

  it("strips IBAN spaces and upper-cases it", () => {
    const payload = buildEpcQrPayload({
      beneficiary: "Fund",
      iban: "be82 1036 0037 1868",
      amount: 10,
      reference: "REF",
    });
    expect(payload).toContain("\nBE82103600371868\n");
  });

  it("formats the amount to two decimals", () => {
    const payload = buildEpcQrPayload({
      beneficiary: "Fund",
      iban: "BE82103600371868",
      amount: 12.5,
      reference: "REF",
    });
    expect(payload).toContain("\nEUR12.50\n");
  });

  it("returns null without a usable IBAN or a positive amount", () => {
    expect(
      buildEpcQrPayload({ beneficiary: "F", iban: "", amount: 10, reference: "R" }),
    ).toBeNull();
    expect(
      buildEpcQrPayload({
        beneficiary: "F",
        iban: "BE82103600371868",
        amount: 0,
        reference: "R",
      }),
    ).toBeNull();
  });

  it("truncates an over-long remittance to 140 chars", () => {
    const payload = buildEpcQrPayload({
      beneficiary: "Fund",
      iban: "BE82103600371868",
      amount: 10,
      reference: "x".repeat(200),
    });
    const remittance = payload!.split("\n").at(-1)!;
    expect(remittance).toHaveLength(140);
  });
});
