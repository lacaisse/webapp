// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { authorizeResumeUrl, signedOAuthQueryFromSearch } from "./oauth-query";

const signed =
  "client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Fcallback&response_type=code&scope=openid+offline_access&prompt=login+consent&exp=1700000000&ba_iat=1699999000&ba_param=ba_param&ba_param=client_id&sig=xyz";

describe("signedOAuthQueryFromSearch", () => {
  it("returns the query of an authorize redirect, without the '?'", () => {
    expect(signedOAuthQueryFromSearch(`?${signed}`)).toBe(signed);
    expect(signedOAuthQueryFromSearch(signed)).toBe(signed);
  });

  it("ignores ordinary login page queries", () => {
    expect(signedOAuthQueryFromSearch("?return_to=https%3A%2F%2Fx")).toBeNull();
    expect(signedOAuthQueryFromSearch("")).toBeNull();
    expect(signedOAuthQueryFromSearch(null)).toBeNull();
  });
});

describe("authorizeResumeUrl", () => {
  it("re-enters authorize with the original parameters only", () => {
    const url = new URL(authorizeResumeUrl(signed), "http://auth.localhost");
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("scope")).toBe("openid offline_access");
    for (const name of ["sig", "exp", "ba_iat", "ba_param"]) {
      expect(url.searchParams.has(name)).toBe(false);
    }
  });

  it("drops a satisfied prompt=login but keeps other prompt values", () => {
    const url = new URL(authorizeResumeUrl(signed), "http://auth.localhost");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const only = authorizeResumeUrl("client_id=abc&prompt=login&sig=x");
    expect(new URL(only, "http://a").searchParams.has("prompt")).toBe(false);
  });
});
