// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

import {
  checkSeedAllowed,
  foreignFundIds,
  foreignUserEmails,
  runSeed,
  SEED_FUNDS,
  SEED_USER_EMAILS,
  SeedRefused,
} from "./seed-staging";

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

  it("lists users it did not create", () => {
    const ours = [...SEED_USER_EMAILS];
    expect(ours).toContain("platform-admin@example.org");
    expect(ours).toContain("owner.alpha@example.org");
    expect(foreignUserEmails(ours)).toEqual([]);
    expect(foreignUserEmails([...ours, "someone@example.com"])).toEqual(["someone@example.com"]);
    for (const email of ours) expect(email).toMatch(/@example\.org$/);
  });

  it("seeds only obviously synthetic data", () => {
    const domains = SEED_FUNDS.map((f) => f.domain);
    expect(domains).toContain("caisse-gamma.example.org"); // one custom domain
    expect(domains.filter((d) => d.endsWith(".lacaisse.eu")).length).toBeGreaterThan(0);
    for (const f of SEED_FUNDS) expect(f.name).toMatch(/^Synthetic /);
  });
});

// runSeed's decisions before any write, on a stub database that records writes.
function stubDb(funds: string[], users: string[]) {
  const writes: string[] = [];
  const write = (what: string) => async () => {
    writes.push(what);
    throw new Error("unexpected write");
  };
  const db = {
    fund: { findMany: async () => funds.map((id) => ({ id })), findUnique: write("fund.findUnique") },
    user: { findMany: async () => users.map((email) => ({ email })), findUnique: write("user.findUnique") },
  };
  return { db: db as never, writes };
}

const KEY = "11".repeat(32);

describe("runSeed", () => {
  it("refuses without SEED_SYNTHETIC_OK, before reading anything", async () => {
    const { db, writes } = stubDb([], []);
    await expect(runSeed(db, { APP_CRED_KEY: KEY } as never)).rejects.toBeInstanceOf(SeedRefused);
    expect(writes).toEqual([]);
  });

  it("needs APP_CRED_KEY", async () => {
    const { db, writes } = stubDb([], []);
    await expect(runSeed(db, { SEED_SYNTHETIC_OK: "1" } as never)).rejects.toThrow(/APP_CRED_KEY/);
    expect(writes).toEqual([]);
  });

  it.each([
    ["a foreign fund", ["seed-synthetic-fund-alpha", "cmrealfund"], []],
    ["a foreign user", [], ["someone@example.com"]],
  ])("skips, writing nothing, with %s", async (_, funds, users) => {
    const { db, writes } = stubDb(funds as string[], users as string[]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runSeed(db, { SEED_SYNTHETIC_OK: "1", APP_CRED_KEY: KEY } as never)).resolves.toBe(
      "skipped",
    );
    expect(writes).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^Synthetic seed skipped/);
    log.mockRestore();
  });
});
