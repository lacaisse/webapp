// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  buildRegistrationPrefill,
  DEFAULT_REGISTER_CHAIN_PREFIX,
  normaliseSymbol,
} from "./register-prefill";

describe("normaliseSymbol (CP deploy route wants ^[A-Z0-9]{2,8}$)", () => {
  it.each([
    ["class", "CLASS"],
    ["Cl-Ass €", "CLASS"],
    ["abcdefghij", "ABCDEFGH"],
    ["  bru  ", "BRU"],
    ["b2", "B2"],
  ])("%j → %j", (raw, want) => {
    expect(normaliseSymbol(raw)).toBe(want);
  });

  it.each([["x"], ["€€"], [""], ["   "], [null], [undefined]])(
    "%j → null (fewer than 2 characters survive)",
    (raw) => {
      expect(normaliseSymbol(raw)).toBeNull();
    },
  );
});

describe("buildRegistrationPrefill", () => {
  it("sends name, symbol, 6 decimals and Gnosis' chain_prefix \"100\"", () => {
    expect(
      buildRegistrationPrefill({ name: "Caisse Locale", symbol: "CLASS" }),
    ).toEqual({
      name: "Caisse Locale",
      symbol: "CLASS",
      decimals: "6",
      chain: "100",
    });
    expect(DEFAULT_REGISTER_CHAIN_PREFIX).toBe("100");
  });

  it("omits a missing or blank symbol and trims the name", () => {
    expect(buildRegistrationPrefill({ name: "  Caisse  ", symbol: null })).toEqual({
      name: "Caisse",
      decimals: "6",
      chain: DEFAULT_REGISTER_CHAIN_PREFIX,
    });
    expect(buildRegistrationPrefill({ name: "Caisse", symbol: "   " })).not.toHaveProperty(
      "symbol",
    );
  });

  it("omits a blank name rather than sending whitespace", () => {
    expect(buildRegistrationPrefill({ name: "   " })).not.toHaveProperty("name");
  });

  it("normalises the symbol and drops one CP would reject", () => {
    expect(buildRegistrationPrefill({ name: "x", symbol: "la class €" }).symbol).toBe(
      "LACLASS",
    );
    expect(buildRegistrationPrefill({ name: "x", symbol: "€" })).not.toHaveProperty(
      "symbol",
    );
  });

  it("passes key_name through and omits it when blank", () => {
    expect(
      buildRegistrationPrefill({ name: "x", keyName: "La Caisse — initial 2026-10-20" })
        .key_name,
    ).toBe("La Caisse — initial 2026-10-20");
    expect(buildRegistrationPrefill({ name: "x", keyName: "  " })).not.toHaveProperty(
      "key_name",
    );
  });

  it("honours a chain prefix override", () => {
    expect(buildRegistrationPrefill({ name: "x" }, "gnosis").chain).toBe("gnosis");
  });

  it("survives URLSearchParams round-trip the way CP reads it", () => {
    const url = new URL("https://api.example/v2/treasury/register");
    url.searchParams.set("redirect_uri", "https://acme.lacaisse.eu/api/citizenpay/callback/abc");
    for (const [k, v] of Object.entries(
      buildRegistrationPrefill({ name: "Caisse & Co", symbol: "C&C" }),
    )) {
      url.searchParams.set(k, v);
    }
    const back = new URL(url.toString()).searchParams;
    expect(back.get("name")).toBe("Caisse & Co");
    expect(back.get("symbol")).toBe("CC");
    expect(back.get("decimals")).toBe("6");
    expect(back.get("redirect_uri")).toBe(
      "https://acme.lacaisse.eu/api/citizenpay/callback/abc",
    );
  });
});
