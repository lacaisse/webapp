// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { langParamRedirect } from "./lang-param";

describe("langParamRedirect", () => {
  it("returns the locale and the URL without lang, other params intact", () => {
    const result = langParamRedirect(
      new URL("https://fund.example.org/pay/ABC123?amount=20&lang=fr&ref=wallet"),
    );
    expect(result).not.toBeNull();
    expect(result!.locale).toBe("fr");
    expect(result!.target.href).toBe(
      "https://fund.example.org/pay/ABC123?amount=20&ref=wallet",
    );
    expect(result!.target.searchParams.has("lang")).toBe(false);
  });

  it("drops the query string entirely when lang was the only param", () => {
    const result = langParamRedirect(
      new URL("https://fund.example.org/pay/ABC123?lang=nl"),
    );
    expect(result?.locale).toBe("nl");
    expect(result?.target.href).toBe("https://fund.example.org/pay/ABC123");
  });

  it("accepts every supported locale, including es", () => {
    for (const lang of ["en", "fr", "nl", "es"]) {
      const result = langParamRedirect(
        new URL(`https://fund.example.org/pay/X?lang=${lang}`),
      );
      expect(result?.locale).toBe(lang);
    }
  });

  it("does not mutate the input URL", () => {
    const url = new URL("https://fund.example.org/pay/X?lang=fr");
    langParamRedirect(url);
    expect(url.href).toBe("https://fund.example.org/pay/X?lang=fr");
  });

  it("returns null for an unsupported lang", () => {
    expect(
      langParamRedirect(new URL("https://fund.example.org/pay/X?lang=de")),
    ).toBeNull();
    expect(
      langParamRedirect(new URL("https://fund.example.org/pay/X?lang=")),
    ).toBeNull();
    expect(
      langParamRedirect(new URL("https://fund.example.org/pay/X?lang=fr-BE")),
    ).toBeNull();
  });

  it("returns null when there is no lang param", () => {
    expect(langParamRedirect(new URL("https://fund.example.org/pay/X"))).toBeNull();
    expect(
      langParamRedirect(new URL("https://fund.example.org/pay/X?amount=20")),
    ).toBeNull();
  });

  it("lowercases the value, so uppercase FR is honoured as fr", () => {
    const result = langParamRedirect(
      new URL("https://fund.example.org/pay/X?LANGUAGE=x&lang=FR"),
    );
    expect(result?.locale).toBe("fr");
    expect(result?.target.href).toBe("https://fund.example.org/pay/X?LANGUAGE=x");
  });
});
