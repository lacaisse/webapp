// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isCrossSiteRequest } from "./sec-fetch-site";

const h = (site?: string) =>
  new Headers(site === undefined ? {} : { "sec-fetch-site": site });

describe("isCrossSiteRequest", () => {
  it("lets our own pages through", () => {
    expect(isCrossSiteRequest(h("same-origin"))).toBe(false);
    expect(isCrossSiteRequest(h("same-site"))).toBe(false);
    expect(isCrossSiteRequest(h("Same-Site "))).toBe(false);
  });

  it("refuses cross-site and direct navigations", () => {
    expect(isCrossSiteRequest(h("cross-site"))).toBe(true);
    expect(isCrossSiteRequest(h("none"))).toBe(true);
    expect(isCrossSiteRequest(h(""))).toBe(true);
  });

  it("lets a request without the header through (not the auth layer)", () => {
    expect(isCrossSiteRequest(h())).toBe(false);
  });
});
