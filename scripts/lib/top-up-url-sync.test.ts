// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { probeTopUpUrl, runTopUpUrlSync } from "./top-up-url-sync";

const funds = [
  { domain: "laclass.lacaisse.eu", allocationMode: "PAY_AND_GO" as const },
  { domain: "other.lacaisse.eu", allocationMode: "FIXED_PERIOD" as const },
];

function prodEnv() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_DOMAIN", "lacaisse.eu");
}
function forgotEnv() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("APP_DOMAIN", "lacaisse.eu");
}

afterEach(() => vi.unstubAllEnvs());

describe("scripts/sync-top-up-urls", () => {
  it("is a dry run by default: prints the URLs, writes nothing", async () => {
    prodEnv();
    const push = vi.fn();
    const lines: string[] = [];
    const code = await runTopUpUrlSync({ funds, apply: false, push, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(push).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("https://laclass.lacaisse.eu/pay/{serial}");
    expect(lines.join("\n")).toContain("other.lacaisse.eu [FIXED_PERIOD] → (clear)");
  });

  it("writes with --apply when every URL is https", async () => {
    prodEnv();
    const push = vi.fn(async () => {});
    const code = await runTopUpUrlSync({ funds, apply: true, push, log: () => {} });
    expect(code).toBe(0);
    expect(push.mock.calls).toEqual([
      [funds[0], "https://laclass.lacaisse.eu/pay/{serial}"],
      [funds[1], null],
    ]);
  });

  it("refuses --apply on an http URL when NODE_ENV isn't production", async () => {
    forgotEnv();
    expect(probeTopUpUrl()).toBe("http://probe.lacaisse.eu:3000/pay/{serial}");
    const push = vi.fn();
    const code = await runTopUpUrlSync({ funds, apply: true, push, log: () => {} });
    expect(code).toBe(2);
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses --apply on *.localhost URLs", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_DOMAIN", "localhost");
    const push = vi.fn();
    const code = await runTopUpUrlSync({ funds, apply: true, push, log: () => {} });
    expect(code).toBe(2);
    expect(push).not.toHaveBeenCalled();
  });

  it("reports a failed push with exit 1 and carries on", async () => {
    prodEnv();
    const push = vi.fn(async (f: (typeof funds)[number]) => {
      if (f.domain.startsWith("laclass")) throw new Error("HTTP 500");
    });
    const code = await runTopUpUrlSync({ funds, apply: true, push, log: () => {} });
    expect(code).toBe(1);
    expect(push).toHaveBeenCalledTimes(2);
  });
});
