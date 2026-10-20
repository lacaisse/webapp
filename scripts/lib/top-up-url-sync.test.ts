// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { probeTopUpUrl, runTopUpUrlSync } from "./top-up-url-sync";

const funds = [
  { domain: "laclass.lacaisse.eu", allocationMode: "PAY_AND_GO" as const },
  { domain: "other.lacaisse.eu", allocationMode: "DISABLED" as const },
];
type Fund = (typeof funds)[number] | { domain: string; allocationMode: "FIXED_PERIOD" | "DISABLED" };
const CP_CHECKOUT = "https://checkout.citizenpay.xyz/topup";
// Treasury state per fund domain, as GET /v2/treasury would answer it.
const reader = (current: Record<string, string | null>) =>
  vi.fn(async (f: Fund) => current[f.domain] ?? null);

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
    const read = reader({ "other.lacaisse.eu": "https://other.lacaisse.eu/pay/{serial}" });
    const code = await runTopUpUrlSync({
      funds,
      apply: false,
      push,
      read,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(push).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("https://laclass.lacaisse.eu/pay/{serial}");
    expect(lines.join("\n")).toContain("other.lacaisse.eu [DISABLED] → (clear)");
    // Only the fund that computes null is read.
    expect(read).toHaveBeenCalledExactlyOnceWith(funds[1]);
  });

  it("dry run prints (leave: CP-managed URL) for a DISABLED fund on CP's checkout", async () => {
    prodEnv();
    const bxl = { domain: "paybrussels.lacaisse.eu", allocationMode: "DISABLED" as const };
    const lines: string[] = [];
    await runTopUpUrlSync({
      funds: [bxl],
      apply: false,
      push: vi.fn(),
      read: reader({ "paybrussels.lacaisse.eu": CP_CHECKOUT }),
      log: (l) => lines.push(l),
    });
    const out = lines.join("\n");
    expect(out).toContain("paybrussels.lacaisse.eu [DISABLED] → (leave: CP-managed URL)");
    expect(out).not.toContain("(clear)");
  });

  it("dry run without CP access says it didn't read", async () => {
    prodEnv();
    const lines: string[] = [];
    await runTopUpUrlSync({ funds, apply: false, push: vi.fn(), log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("other.lacaisse.eu [DISABLED] → (clear only if it's our own link — CP not read)");
  });

  it("writes with --apply: sets links, clears a DISABLED fund's own stale link", async () => {
    prodEnv();
    const push = vi.fn(async () => {});
    const read = reader({ "other.lacaisse.eu": "https://other.lacaisse.eu/pay/{serial}" });
    const code = await runTopUpUrlSync({ funds, apply: true, push, read, log: () => {} });
    expect(code).toBe(0);
    expect(push.mock.calls).toEqual([
      [funds[0], "https://laclass.lacaisse.eu/pay/{serial}"],
      [funds[1], null],
    ]);
  });

  it("--apply leaves a CP-managed URL (and an already clear treasury) alone", async () => {
    prodEnv();
    const bxl = { domain: "paybrussels.lacaisse.eu", allocationMode: "DISABLED" as const };
    const empty = { domain: "empty.lacaisse.eu", allocationMode: "DISABLED" as const };
    const cotisation = { domain: "fixed.lacaisse.eu", allocationMode: "FIXED_PERIOD" as const };
    const push = vi.fn(async () => {});
    const code = await runTopUpUrlSync({
      funds: [bxl, empty, cotisation],
      apply: true,
      push,
      read: reader({ "paybrussels.lacaisse.eu": CP_CHECKOUT, "fixed.lacaisse.eu": CP_CHECKOUT }),
      log: () => {},
    });
    expect(code).toBe(0);
    // FIXED_PERIOD still publishes its cotisation page over whatever was there.
    expect(push.mock.calls).toEqual([[cotisation, "https://fixed.lacaisse.eu/pay/{serial}"]]);
  });

  it("--apply clears nothing and exits 1 when the read fails", async () => {
    prodEnv();
    const push = vi.fn(async () => {});
    const read = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    const code = await runTopUpUrlSync({ funds, apply: true, push, read, log: () => {} });
    expect(code).toBe(1);
    expect(push.mock.calls).toEqual([[funds[0], "https://laclass.lacaisse.eu/pay/{serial}"]]);
  });

  it("refuses --apply without a treasury reader", async () => {
    prodEnv();
    const push = vi.fn();
    const code = await runTopUpUrlSync({ funds, apply: true, push, log: () => {} });
    expect(code).toBe(2);
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses --apply on an http URL when NODE_ENV isn't production", async () => {
    forgotEnv();
    expect(probeTopUpUrl()).toBe("http://probe.lacaisse.eu:3000/pay/{serial}");
    const push = vi.fn();
    const code = await runTopUpUrlSync({ funds, apply: true, push, read: reader({}), log: () => {} });
    expect(code).toBe(2);
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses --apply on *.localhost URLs", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_DOMAIN", "localhost");
    const push = vi.fn();
    const read = reader({});
    const code = await runTopUpUrlSync({ funds, apply: true, push, read, log: () => {} });
    expect(code).toBe(2);
    expect(push).not.toHaveBeenCalled();
  });

  it("reports a failed push with exit 1 and carries on", async () => {
    prodEnv();
    const push = vi.fn(async (f: (typeof funds)[number]) => {
      if (f.domain.startsWith("laclass")) throw new Error("HTTP 500");
    });
    const read = reader({ "other.lacaisse.eu": "https://other.lacaisse.eu/pay/{serial}" });
    const code = await runTopUpUrlSync({ funds, apply: true, push, read, log: () => {} });
    expect(code).toBe(1);
    expect(push).toHaveBeenCalledTimes(2);
  });
});
