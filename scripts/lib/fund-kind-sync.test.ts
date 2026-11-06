// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

import { runFundKindSync, type TreasuryKindRead } from "./fund-kind-sync";

const bxl = { domain: "paybrussels.lacaisse.eu" };
const laclass = { domain: "laclass.lacaisse.eu" };
const fresh = { domain: "fresh.lacaisse.eu" };
const funds = [bxl, laclass, fresh];
type Fund = (typeof funds)[number];

// Treasury state per fund domain, as GET /v2/treasury would answer it.
const reader = (current: Record<string, TreasuryKindRead>) =>
  vi.fn(async (f: Fund) => {
    const read = current[f.domain];
    if (!read) throw new Error("HTTP 404: not found");
    return read;
  });
const state = {
  "paybrussels.lacaisse.eu": { slug: "bxl", kind: "fund" as const },
  "laclass.lacaisse.eu": { slug: "class", kind: "token" as const },
  "fresh.lacaisse.eu": { slug: "fresh", kind: "token" as const },
};

describe("scripts/sync-fund-kind", () => {
  it("is a dry run by default: prints the plan, writes nothing", async () => {
    const push = vi.fn();
    const read = reader(state);
    const lines: string[] = [];
    const code = await runFundKindSync({ funds, apply: false, push, read, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(push).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(3);
    const out = lines.join("\n");
    expect(out).toContain("3 connected fund(s) — dry run, pass --apply to write");
    expect(out).toContain("paybrussels.lacaisse.eu → (already fund) [bxl]");
    expect(out).toContain("laclass.lacaisse.eu → set kind=fund [class] (now token)");
    expect(out).toContain("fresh.lacaisse.eu → set kind=fund [fresh] (now token)");
  });

  it("dry run without CP access says it didn't read", async () => {
    const lines: string[] = [];
    await runFundKindSync({ funds: [laclass], apply: false, push: vi.fn(), log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("laclass.lacaisse.eu → set kind=fund (CP not read)");
  });

  it("dry run flags an api that answers without a kind (predates api#260)", async () => {
    const lines: string[] = [];
    await runFundKindSync({
      funds: [laclass],
      apply: false,
      push: vi.fn(),
      read: reader({ "laclass.lacaisse.eu": { slug: "class", kind: null } }),
      log: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toContain(
      "laclass.lacaisse.eu → set kind=fund [class] (api reports no kind — needs api#260)",
    );
  });

  it("dry run reports a failed read and plans nothing for that fund", async () => {
    const lines: string[] = [];
    await runFundKindSync({
      funds: [bxl, fresh],
      apply: false,
      push: vi.fn(),
      read: reader({ "paybrussels.lacaisse.eu": state["paybrussels.lacaisse.eu"] }),
      log: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toContain("fresh.lacaisse.eu → (read failed — HTTP 404: not found)");
  });

  it("--apply writes only the treasuries not already a fund", async () => {
    const push = vi.fn(async () => {});
    const lines: string[] = [];
    const code = await runFundKindSync({
      funds,
      apply: true,
      push,
      read: reader(state),
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(push.mock.calls).toEqual([[laclass], [fresh]]);
    const out = lines.join("\n");
    expect(out).toContain("paybrussels.lacaisse.eu → (already fund) [bxl]: skipped");
    expect(out).toContain("laclass.lacaisse.eu → set kind=fund [class] (now token): ok");
  });

  it("--apply without a reader writes every fund (the PATCH is idempotent)", async () => {
    const push = vi.fn(async () => {});
    const code = await runFundKindSync({ funds, apply: true, push, log: () => {} });
    expect(code).toBe(0);
    expect(push.mock.calls).toEqual([[bxl], [laclass], [fresh]]);
  });

  it("--apply writes nothing for a fund whose read failed and exits 1", async () => {
    const push = vi.fn(async () => {});
    const read = reader({ "laclass.lacaisse.eu": state["laclass.lacaisse.eu"] });
    const lines: string[] = [];
    const code = await runFundKindSync({
      funds: [bxl, laclass],
      apply: true,
      push,
      read,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(push.mock.calls).toEqual([[laclass]]);
    expect(lines.join("\n")).toContain("paybrussels.lacaisse.eu → (read failed — HTTP 404: not found): FAILED");
  });

  it("reports a failed push with exit 1 and carries on", async () => {
    const push = vi.fn(async (f: Fund) => {
      if (f.domain.startsWith("laclass")) throw new Error("HTTP 500");
    });
    const lines: string[] = [];
    const code = await runFundKindSync({
      funds,
      apply: true,
      push,
      read: reader(state),
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(push).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toContain("laclass.lacaisse.eu → set kind=fund [class] (now token): FAILED HTTP 500");
    expect(lines.join("\n")).toContain("fresh.lacaisse.eu → set kind=fund [fresh] (now token): ok");
  });
});
