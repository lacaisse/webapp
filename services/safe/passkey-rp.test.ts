// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { signingPasskeyRpId } from "./passkey-rp";

describe("signingPasskeyRpId", () => {
  it("is the apex in production, whatever host the request came in on", () => {
    expect(signingPasskeyRpId("lacaisse.eu", "acme.lacaisse.eu")).toBe("lacaisse.eu");
    expect(signingPasskeyRpId("lacaisse.eu", "funds.acme.com")).toBe("lacaisse.eu");
  });

  it("is the request host (without port) when the apex is localhost", () => {
    expect(signingPasskeyRpId("localhost", "caisse-test.localhost:3031")).toBe("caisse-test.localhost");
    expect(signingPasskeyRpId("localhost", "")).toBe("localhost");
  });
});
