// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { citizenPayDashboardUrls, normaliseDashboardBaseUrl } from "./citizenpay-dashboard";
import { DEFAULT_CITIZENPAY_DASHBOARD_URL } from "./config";

describe("normaliseDashboardBaseUrl", () => {
  it("trims and strips trailing slashes", () => {
    expect(normaliseDashboardBaseUrl("  https://my.staging.citizenpay.xyz//  ")).toBe(
      "https://my.staging.citizenpay.xyz",
    );
    expect(normaliseDashboardBaseUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });

  it("falls back to the default when empty", () => {
    expect(normaliseDashboardBaseUrl(undefined)).toBe(DEFAULT_CITIZENPAY_DASHBOARD_URL);
    expect(normaliseDashboardBaseUrl(null)).toBe(DEFAULT_CITIZENPAY_DASHBOARD_URL);
    expect(normaliseDashboardBaseUrl("")).toBe(DEFAULT_CITIZENPAY_DASHBOARD_URL);
    expect(normaliseDashboardBaseUrl("  / ")).toBe(DEFAULT_CITIZENPAY_DASHBOARD_URL);
  });
});

describe("citizenPayDashboardUrls", () => {
  it("links the business's banking and billing pages", () => {
    expect(citizenPayDashboardUrls("https://my.citizenpay.xyz/", "biz-1")).toEqual({
      home: "https://my.citizenpay.xyz/",
      banking: "https://my.citizenpay.xyz/biz-1/banking",
      billing: "https://my.citizenpay.xyz/biz-1/billing",
    });
  });

  it("encodes the business id", () => {
    expect(citizenPayDashboardUrls("https://my.citizenpay.xyz", "a/b c").banking).toBe(
      "https://my.citizenpay.xyz/a%2Fb%20c/banking",
    );
  });

  it("falls back to the dashboard root without a business id", () => {
    const root = "https://my.citizenpay.xyz/";
    expect(citizenPayDashboardUrls("https://my.citizenpay.xyz", null)).toEqual({
      home: root,
      banking: root,
      billing: root,
    });
  });
});
