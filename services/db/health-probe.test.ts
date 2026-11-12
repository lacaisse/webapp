// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { pg } = vi.hoisted(() => {
  const instances: Array<{ config: Record<string, unknown>; connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> = [];
  class Client {
    config: Record<string, unknown>;
    connect = vi.fn(async () => {});
    query = vi.fn(async () => ({ rows: [{ "?column?": 1 }] }));
    end = vi.fn(async () => {});
    constructor(config: Record<string, unknown>) {
      this.config = config;
      instances.push(this);
    }
  }
  return { pg: { Client, instances } };
});
vi.mock("pg", () => ({ Client: pg.Client }));

import { selectOne } from "./health-probe";

beforeEach(() => {
  pg.instances.length = 0;
  vi.stubEnv("DATABASE_URL", "postgres://u:p@10.0.0.6:5432/lacaisse");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("selectOne", () => {
  it("bounds connecting and the query, and closes the connection", async () => {
    await selectOne(2_000);
    const [c] = pg.instances;
    expect(c!.config).toMatchObject({ connectionTimeoutMillis: 2_000, query_timeout: 2_000 });
    expect(c!.query).toHaveBeenCalledWith("SELECT 1");
    expect(c!.end).toHaveBeenCalledTimes(1);
  });

  it("closes the connection when the query fails, and rejects", async () => {
    const run = selectOne(2_000);
    // connect() is awaited first, so the query mock is in place in time.
    pg.instances[0]!.query.mockRejectedValueOnce(new Error("Query read timeout"));
    await expect(run).rejects.toThrow("Query read timeout");
    expect(pg.instances[0]!.end).toHaveBeenCalledTimes(1);
  });

  it("uses the same TLS settings as the app with DATABASE_CA_CERT", async () => {
    vi.stubEnv(
      "DATABASE_CA_CERT",
      "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----",
    );
    await selectOne(2_000);
    expect(pg.instances[0]!.config.ssl).toMatchObject({ rejectUnauthorized: true });
  });
});
