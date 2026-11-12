// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

// The container build opts into `output: "standalone"` with NEXT_OUTPUT; any
// other build (Vercel) must get the config it always had.

async function loadConfig() {
  vi.resetModules();
  return (await import("./next.config")).default as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config", () => {
  it("has no `output` key without NEXT_OUTPUT", async () => {
    delete process.env.NEXT_OUTPUT;
    const config = await loadConfig();
    expect(Object.keys(config)).not.toContain("output");
  });

  it("ignores any NEXT_OUTPUT value but standalone", async () => {
    vi.stubEnv("NEXT_OUTPUT", "export");
    expect(Object.keys(await loadConfig())).not.toContain("output");
  });

  it("differs only by `output` with NEXT_OUTPUT=standalone", async () => {
    delete process.env.NEXT_OUTPUT;
    const plain = await loadConfig();
    vi.stubEnv("NEXT_OUTPUT", "standalone");
    const standalone = await loadConfig();
    expect(standalone.output).toBe("standalone");
    const rest = { ...standalone };
    delete rest.output;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
  });
});
