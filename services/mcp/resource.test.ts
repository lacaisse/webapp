// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { MCP_PATH, MCP_SCOPES, mcpResourceForOrigin } from "./resource";

describe("mcpResourceForOrigin", () => {
  it("appends the MCP path to a bare origin", () => {
    expect(mcpResourceForOrigin("https://acme.lacaisse.eu")).toBe(
      `https://acme.lacaisse.eu${MCP_PATH}`,
    );
  });

  it("tolerates a trailing slash and keeps dev ports", () => {
    expect(mcpResourceForOrigin("http://acme.localhost:3028/")).toBe(
      "http://acme.localhost:3028/api/mcp",
    );
  });

  it("issues refresh tokens by default (offline_access is a default scope)", () => {
    expect(MCP_SCOPES).toContain("offline_access");
  });
});
