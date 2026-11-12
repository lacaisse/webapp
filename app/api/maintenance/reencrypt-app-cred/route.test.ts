// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

import { decryptWith, encryptWith } from "@/scripts/lib/app-cred-rotation";

// An in-memory stand-in for the two tables, enough for scanRotation /
// applyRotation (findMany with the not-null filters, conditioned
// updateMany, an interactive transaction).
vi.mock("server-only", () => ({}));
const { db } = vi.hoisted(() => {
  type FundRow = Record<string, string | null> & { id: string };
  type SignerRow = { id: string; fundId: string; userId: string; privateKeyEnc: string | null };
  const state = { funds: [] as FundRow[], signers: [] as SignerRow[] };
  const COLS = ["tokenMinterPrivateKeyEnc", "citizenPayApiKeyEnc", "citizenPayEventsSecretEnc"];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const db = {
    state,
    fund: {
      findMany: async () =>
        state.funds.filter((f) => COLS.some((c) => f[c] != null)).map((f) => ({ ...f })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, string> }) => {
        const rows = state.funds.filter((f) => matches(f, where));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
    },
    fundSigner: {
      findMany: async () =>
        state.signers.filter((s) => s.privateKeyEnc != null).map((s) => ({ ...s })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, string> }) => {
        const rows = state.signers.filter((s) => matches(s, where));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const snapshot = JSON.stringify(state);
      try {
        await fn(db);
      } catch (e) {
        const back = JSON.parse(snapshot);
        state.funds = back.funds;
        state.signers = back.signers;
        throw e;
      }
    },
  };
  return { db };
});
vi.mock("@/services/db/prisma", () => ({ prisma: db }));

import { REENCRYPT_BATCH_SIZE } from "@/services/crypto/reencrypt";
import { POST } from "./route";

const OLD = randomBytes(32);
const NEW = randomBytes(32);

const req = (auth: string | null = "Bearer test-cron-secret") =>
  new NextRequest("http://10.0.0.3:3000/api/maintenance/reencrypt-app-cred", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });

function seed(funds: number, signers: number, key: Buffer) {
  db.state.funds = Array.from({ length: funds }, (_, i) => ({
    id: `f${String(i).padStart(3, "0")}`,
    tokenMinterPrivateKeyEnc: encryptWith(key, `minter-${i}`, "v1"),
    citizenPayApiKeyEnc: i % 2 === 0 ? encryptWith(key, `api-${i}`, "v1") : null,
    citizenPayEventsSecretEnc: null,
  }));
  db.state.signers = Array.from({ length: signers }, (_, i) => ({
    id: `s${i}`,
    fundId: "f000",
    userId: `u${i}`,
    privateKeyEnc: encryptWith(key, `signer-${i}`, "v2", `signer:f000:u${i}`),
  }));
}

beforeEach(() => {
  vi.stubEnv("DEPLOY_TARGET", "container");
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  vi.stubEnv("APP_CRED_KEY", NEW.toString("hex"));
  vi.stubEnv("APP_CRED_KEY_PREVIOUS", OLD.toString("hex"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/maintenance/reencrypt-app-cred", () => {
  it("walks to done in bounded batches, then is a no-op", async () => {
    seed(60, 3, OLD); // 60 minters + 30 api keys + 3 signers = 93 cells
    const answers = [];
    for (let i = 0; i < 5; i++) {
      const res = await POST(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      answers.push(body);
      if (body.done) break;
    }
    expect(answers).toEqual([
      { done: false, reencrypted: REENCRYPT_BATCH_SIZE, remaining: 93 - REENCRYPT_BATCH_SIZE },
      { done: true, reencrypted: 93 - REENCRYPT_BATCH_SIZE, remaining: 0 },
    ]);
    // Every cell now opens with the new key, same plaintext, same binding.
    expect(decryptWith(NEW, db.state.funds[7]!.tokenMinterPrivateKeyEnc!)).toBe("minter-7");
    expect(decryptWith(NEW, db.state.signers[2]!.privateKeyEnc!, "signer:f000:u2")).toBe("signer-2");

    const again = await POST(req());
    expect(await again.json()).toEqual({ done: true, reencrypted: 0, remaining: 0 });
  });

  it("done at once without a previous key when everything is current", async () => {
    seed(2, 1, NEW);
    vi.stubEnv("APP_CRED_KEY_PREVIOUS", "");
    expect(await (await POST(req())).json()).toEqual({ done: true, reencrypted: 0, remaining: 0 });
  });

  it("409 and nothing written when a cell opens with neither key", async () => {
    seed(3, 0, OLD);
    db.state.funds[1]!.tokenMinterPrivateKeyEnc = encryptWith(randomBytes(32), "x", "v1");
    const before = JSON.stringify(db.state);
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ done: false, reencrypted: 0, failed: 1 });
    expect(JSON.stringify(db.state)).toBe(before);
  });

  it("500 on a malformed key", async () => {
    vi.stubEnv("APP_CRED_KEY_PREVIOUS", "not-hex");
    expect((await POST(req())).status).toBe(500);
  });

  it("401 without the bearer", async () => {
    seed(1, 0, OLD);
    expect((await POST(req(null))).status).toBe(401);
    expect(decryptWith(OLD, db.state.funds[0]!.tokenMinterPrivateKeyEnc!)).toBe("minter-0");
  });

  it("503, never a done-shaped answer, where a cron route would answer skipped", async () => {
    vi.stubEnv("DEPLOY_TARGET", "");
    const res = await POST(req());
    expect(res.status).toBe(503);
  });
});
