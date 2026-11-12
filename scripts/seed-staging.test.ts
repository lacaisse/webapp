// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { checkSeedAllowed, foreignFundIds, SEED_FUNDS, SeedRefused } from "./seed-staging";

describe("seed-staging guards", () => {
  it("refuses unless SEED_SYNTHETIC_OK is exactly 1", () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(() => checkSeedAllowed({ SEED_SYNTHETIC_OK: value } as unknown as NodeJS.ProcessEnv)).toThrow(
        SeedRefused,
      );
    }
    expect(() => checkSeedAllowed({ SEED_SYNTHETIC_OK: "1" } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("lists funds it did not create", () => {
    const ours = SEED_FUNDS.map((f) => f.id);
    expect(foreignFundIds([])).toEqual([]);
    expect(foreignFundIds(ours)).toEqual([]);
    expect(foreignFundIds([...ours, "cm123realfund"])).toEqual(["cm123realfund"]);
  });

  it("seeds only obviously synthetic data", () => {
    const domains = SEED_FUNDS.map((f) => f.domain);
    expect(domains).toContain("caisse-gamma.example.org"); // one custom domain
    expect(domains.filter((d) => d.endsWith(".lacaisse.eu")).length).toBeGreaterThan(0);
    for (const f of SEED_FUNDS) expect(f.name).toMatch(/^Synthetic /);
  });
});
