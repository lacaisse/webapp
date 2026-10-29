// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { redactRpcKey } from "./redact";

describe("redactRpcKey", () => {
  it("hides the key segment of an Alchemy URL, wherever it appears", () => {
    expect(
      redactRpcKey(
        "HTTP request failed. URL: https://gnosis-mainnet.g.alchemy.com/v2/AbCdEf123456_xyz-9 Request body: {}",
      ),
    ).toBe("HTTP request failed. URL: https://gnosis-mainnet.g.alchemy.com/v2/[redacted] Request body: {}");
    expect(redactRpcKey("a /v2/k1 and /v2/k2k2k2k2k2 twice")).toBe("a /v2/k1 and /v2/[redacted] twice");
  });

  it("leaves other text alone", () => {
    expect(redactRpcKey("GS026: invalid owner provided")).toBe("GS026: invalid owner provided");
    expect(redactRpcKey("/v2/multisig-transactions/0xabc/")).toBe(
      "/v2/[redacted]/0xabc/",
    );
  });
});
