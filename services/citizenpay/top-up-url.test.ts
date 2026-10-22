// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { isOwnTopUpUrl, topUpUrlFor } from "./top-up-url";

afterEach(() => vi.unstubAllEnvs());

function prod() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_DOMAIN", "lacaisse.eu");
}

describe("topUpUrlFor", () => {
  it("links FIXED_PERIOD funds to their /pay/{serial} cotisation page", () => {
    prod();
    expect(
      topUpUrlFor({ domain: "laclass.lacaisse.eu", allocationMode: "FIXED_PERIOD" }),
    ).toBe("https://laclass.lacaisse.eu/pay/{serial}");
  });

  it("keeps a custom domain verbatim", () => {
    prod();
    expect(
      topUpUrlFor({ domain: "funds.acme.com", allocationMode: "FIXED_PERIOD" }),
    ).toBe("https://funds.acme.com/pay/{serial}");
  });

  // PAY_AND_GO: CP serves its own checkout as the treasury's default
  // top_up_url, so La Caisse publishes nothing. DISABLED: no money taken.
  it.each(["PAY_AND_GO", "DISABLED"] as const)("returns null for %s", (mode) => {
    prod();
    expect(
      topUpUrlFor({ domain: "laclass.lacaisse.eu", allocationMode: mode }),
    ).toBeNull();
  });

  it("builds the routable dev host (http + PORT, *.localhost)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_DOMAIN", "localhost");
    vi.stubEnv("PORT", "3000");
    expect(
      topUpUrlFor({ domain: "acme.lacaisse.eu", allocationMode: "FIXED_PERIOD" }),
    ).toBe("http://acme.localhost:3000/pay/{serial}");
    expect(
      topUpUrlFor({ domain: "acme.localhost", allocationMode: "FIXED_PERIOD" }),
    ).toBe("http://acme.localhost:3000/pay/{serial}");
  });
});

describe("isOwnTopUpUrl", () => {
  const fund = { domain: "paybrussels.lacaisse.eu" };

  it("recognises the fund's own /pay/{serial} link", () => {
    prod();
    expect(isOwnTopUpUrl(fund, "https://paybrussels.lacaisse.eu/pay/{serial}")).toBe(true);
  });

  it("recognises the production form from a dev environment", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_DOMAIN", "localhost");
    expect(isOwnTopUpUrl(fund, "https://paybrussels.lacaisse.eu/pay/{serial}")).toBe(true);
    expect(isOwnTopUpUrl(fund, "http://paybrussels.localhost:3000/pay/{serial}")).toBe(true);
  });

  it.each([
    ["CP's own checkout", "https://checkout.citizenpay.xyz/topup"],
    ["another fund's link", "https://laclass.lacaisse.eu/pay/{serial}"],
    ["an expanded serial", "https://paybrussels.lacaisse.eu/pay/04A2B7C9D1"],
    ["another path on the fund", "https://paybrussels.lacaisse.eu/join"],
    ["nothing", null],
  ])("rejects %s", (_label, url) => {
    prod();
    expect(isOwnTopUpUrl(fund, url)).toBe(false);
  });
});
