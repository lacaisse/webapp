// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { actionFor, runEventsWebhookSync } from "./events-webhook-sync";

const registered = new Date("2026-11-05T10:00:00Z");
const funds = [
  { domain: "old.lacaisse.eu", citizenPayEventsWebhookRegisteredAt: null, citizenPayEventsWebhookError: null },
  { domain: "broken.lacaisse.eu", citizenPayEventsWebhookRegisteredAt: null, citizenPayEventsWebhookError: "HTTP 400" },
  { domain: "fresh.lacaisse.eu", citizenPayEventsWebhookRegisteredAt: registered, citizenPayEventsWebhookError: null },
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

describe("scripts/register-events-webhooks", () => {
  it("registers the never-registered and the failed, skips the registered", () => {
    prodEnv();
    expect(actionFor(funds[0], false)).toEqual({
      kind: "register",
      url: "https://old.lacaisse.eu/api/citizenpay/events",
      why: "never",
    });
    expect(actionFor(funds[1], false)).toMatchObject({ kind: "register", why: "failed" });
    expect(actionFor(funds[2], false)).toEqual({ kind: "skip", registeredAt: registered });
    expect(actionFor(funds[2], true)).toMatchObject({ kind: "register", why: "forced" });
  });

  it("is a dry run by default: prints the plan, registers nothing", async () => {
    prodEnv();
    const register = vi.fn();
    const lines: string[] = [];
    const code = await runEventsWebhookSync({ funds, apply: false, register, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(register).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("dry run");
    expect(lines.join("\n")).toContain("old.lacaisse.eu → https://old.lacaisse.eu/api/citizenpay/events (never registered)");
    expect(lines.join("\n")).toContain("fresh.lacaisse.eu → (already registered 2026-11-05)");
  });

  it("--apply registers only what needs it and counts failures", async () => {
    prodEnv();
    const register = vi.fn(async (f: (typeof funds)[number]) => {
      if (f.domain === "broken.lacaisse.eu") throw new Error("HTTP 400");
    });
    const code = await runEventsWebhookSync({ funds, apply: true, register, log: () => {} });
    expect(code).toBe(1);
    expect(register.mock.calls.map(([f]) => f.domain)).toEqual(["old.lacaisse.eu", "broken.lacaisse.eu"]);
  });

  it("--force re-registers every fund", async () => {
    prodEnv();
    const register = vi.fn(async () => {});
    const code = await runEventsWebhookSync({ funds, apply: true, force: true, register, log: () => {} });
    expect(code).toBe(0);
    expect(register).toHaveBeenCalledTimes(3);
  });

  it("refuses --apply when the environment builds a non-https url", async () => {
    forgotEnv();
    const register = vi.fn();
    const lines: string[] = [];
    const code = await runEventsWebhookSync({ funds, apply: true, register, log: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(register).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/Refusing to write/);
  });
});
