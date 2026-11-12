// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { classifyHostname } from "./hostname-allowed";

const STAGING = "staging.lacaisse.eu";

describe("classifyHostname on a two-level apex (staging.lacaisse.eu)", () => {
  it.each([
    ["staging.lacaisse.eu", { kind: "allow" }],
    ["auth.staging.lacaisse.eu", { kind: "allow" }],
    // A fund subdomain is looked up under its canonical stored form.
    ["acme.staging.lacaisse.eu", { kind: "lookup", domain: "acme.lacaisse.eu" }],
    // A custom domain is looked up verbatim.
    ["caisse.example.org", { kind: "lookup", domain: "caisse.example.org" }],
    // Reserved infra names and deeper names are never funds.
    ["www.staging.lacaisse.eu", { kind: "deny" }],
    ["api.staging.lacaisse.eu", { kind: "deny" }],
    ["a.b.staging.lacaisse.eu", { kind: "deny" }],
    // Production's names are not this deployment's.
    ["lacaisse.eu", { kind: "deny" }],
    ["acme.lacaisse.eu", { kind: "deny" }],
    ["auth.lacaisse.eu", { kind: "deny" }],
    ["localhost", { kind: "deny" }],
  ])("%s", (hostname, expected) => {
    expect(classifyHostname(hostname, STAGING)).toEqual(expected);
  });
});

describe("classifyHostname on the production apex", () => {
  it.each([
    ["lacaisse.eu", { kind: "allow" }],
    ["auth.lacaisse.eu", { kind: "allow" }],
    ["acme.lacaisse.eu", { kind: "lookup", domain: "acme.lacaisse.eu" }],
    ["funds.acme.com", { kind: "lookup", domain: "funds.acme.com" }],
    ["app.lacaisse.eu", { kind: "deny" }],
  ])("%s", (hostname, expected) => {
    expect(classifyHostname(hostname, "lacaisse.eu")).toEqual(expected);
  });
});

describe("classifyHostname input validation", () => {
  it.each([
    "",
    "ACME.staging.lacaisse.eu",
    "acme.staging.lacaisse.eu.",
    "acme..staging.lacaisse.eu",
    "-acme.staging.lacaisse.eu",
    "acme_x.staging.lacaisse.eu",
    "acme.staging.lacaisse.eu:443",
    "https://acme.staging.lacaisse.eu",
    "acme.staging.lacaisse.eu/x",
    "a b.example.org",
    `${"a".repeat(64)}.example.org`,
    `${"a.".repeat(127)}org`,
  ])("rejects %j", (hostname) => {
    expect(classifyHostname(hostname, STAGING)).toEqual({ kind: "invalid" });
  });
});
