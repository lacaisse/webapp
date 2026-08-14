// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { buildInstructions, buildServerInfo, type IdentityFund } from "./identity";

// The server card an MCP client renders. Both branches matter: a server
// registered at a fund's URL must present that caisse, and an apex-registered
// one must fall back to the platform without ever emitting a half-filled card.

const FUND: IdentityFund = {
  name: "Pay for Brussels",
  fullName: "Pay for Brussels ASBL",
  domain: "paybrussels.lacaisse.eu",
  logoUrl: "https://cdn.example/pfb.svg",
};

describe("buildServerInfo", () => {
  it("presents the fund on a fund-registered server", () => {
    const info = buildServerInfo(FUND);
    expect(info.title).toBe("Pay for Brussels ASBL");
    expect(info.description).toContain("Pay for Brussels ASBL");
    expect(info.websiteUrl).toContain("paybrussels");
    expect(info.icons).toEqual([{ src: "https://cdn.example/pfb.svg" }]);
  });

  it("keeps `name` constant across hosts — clients key on it", () => {
    expect(buildServerInfo(FUND).name).toBe(buildServerInfo(null).name);
  });

  it("falls back to the short name when there is no legal name", () => {
    expect(buildServerInfo({ ...FUND, fullName: null }).title).toBe(
      "Pay for Brussels",
    );
    // A blank legal name is a real DB state (an optional free-text column).
    expect(buildServerInfo({ ...FUND, fullName: "   " }).title).toBe(
      "Pay for Brussels",
    );
  });

  it("falls back to the platform mark when the fund has no logo", () => {
    const icons = buildServerInfo({ ...FUND, logoUrl: null }).icons;
    expect(icons?.[0]?.src).toContain("/logo.png");
    expect(icons?.[0]?.mimeType).toBe("image/png");
  });

  it("presents the platform on an apex-registered server", () => {
    const info = buildServerInfo(null);
    expect(info.title).toBe("La Caisse");
    expect(info.icons?.[0]?.src).toContain("/logo.png");
  });
});

describe("buildInstructions", () => {
  it("tells the agent the fund is implicit when one is in scope", () => {
    const text = buildInstructions(FUND);
    expect(text).toContain("Pay for Brussels ASBL");
    expect(text).toContain("paybrussels.lacaisse.eu");
    expect(text).toContain("omit the `fund` argument");
  });

  it("sends an apex-connected agent to list_funds instead", () => {
    const text = buildInstructions(null);
    expect(text).toContain("list_funds");
    expect(text).not.toContain("omit the `fund` argument");
  });

  it("warns that the burn is irreversible in both branches", () => {
    for (const text of [buildInstructions(FUND), buildInstructions(null)]) {
      expect(text).toContain("irreversible");
    }
  });
});
