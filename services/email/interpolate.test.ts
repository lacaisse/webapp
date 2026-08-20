// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { dropBlankTokenLines, interpolate } from "./interpolate";

describe("interpolate", () => {
  it("substitutes known tokens and leaves unknown ones literal", () => {
    expect(interpolate("Hi {firstName}, ref {unknown}", { firstName: "Alex" })).toBe(
      "Hi Alex, ref {unknown}",
    );
  });
});

describe("dropBlankTokenLines", () => {
  it("drops an HTML line whose token resolved to a blank value", () => {
    const html = [
      '<p>Référence de paiement : {paymentReference}</p>',
      "<p>IBAN : {iban}</p>",
    ].join("\n");

    const result = dropBlankTokenLines(html, {
      paymentReference: "04A2B7C9D1",
      iban: "",
    });

    expect(result).toBe('<p>Référence de paiement : {paymentReference}</p>\n');
    expect(result).not.toContain("IBAN");
  });

  it("keeps the line when the token has a value", () => {
    const html = "<p>IBAN : {iban}</p>";
    const result = dropBlankTokenLines(html, { iban: "BE71 0961 2345 6769" });
    expect(result).toBe(html);
  });

  it("drops a blank-token line in plain text too", () => {
    const text = "Payment reference: {paymentReference}\nIBAN: {iban}\n";
    const result = dropBlankTokenLines(text, {
      paymentReference: "04A2B7C9D1",
      iban: "",
    });
    expect(result).toBe("Payment reference: {paymentReference}\n");
  });

  it("is a no-op when no vars are blank", () => {
    const html = "<p>Hi {firstName}</p>";
    expect(dropBlankTokenLines(html, { firstName: "Alex" })).toBe(html);
  });
});
