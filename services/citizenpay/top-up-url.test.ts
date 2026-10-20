// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { topUpUrlFor } from "./top-up-url";

afterEach(() => vi.unstubAllEnvs());

function prod() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_DOMAIN", "lacaisse.eu");
}

describe("topUpUrlFor", () => {
  it("links PAY_AND_GO funds to their /pay/{serial} page", () => {
    prod();
    expect(
      topUpUrlFor({ domain: "laclass.lacaisse.eu", allocationMode: "PAY_AND_GO" }),
    ).toBe("https://laclass.lacaisse.eu/pay/{serial}");
  });

  it("keeps a custom domain verbatim", () => {
    prod();
    expect(
      topUpUrlFor({ domain: "funds.acme.com", allocationMode: "PAY_AND_GO" }),
    ).toBe("https://funds.acme.com/pay/{serial}");
  });

  it.each(["FIXED_PERIOD", "DISABLED"] as const)("returns null for %s", (mode) => {
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
      topUpUrlFor({ domain: "acme.lacaisse.eu", allocationMode: "PAY_AND_GO" }),
    ).toBe("http://acme.localhost:3000/pay/{serial}");
    expect(
      topUpUrlFor({ domain: "acme.localhost", allocationMode: "PAY_AND_GO" }),
    ).toBe("http://acme.localhost:3000/pay/{serial}");
  });
});
