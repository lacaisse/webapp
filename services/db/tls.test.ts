// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { normalizeCaPem, pgTlsConfig, stripTlsParams } from "./tls";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfakefakefake\n-----END CERTIFICATE-----";

describe("pgTlsConfig", () => {
  it("leaves the URL untouched without a CA (the Vercel path)", () => {
    const url = "postgresql://u:p@db.example.org:6543/postgres?sslmode=require&pgbouncer=true";
    expect(pgTlsConfig(url, undefined)).toEqual({ connectionString: url });
    expect(pgTlsConfig(url, "")).toEqual({ connectionString: url });
    expect(pgTlsConfig(url, "   ")).toEqual({ connectionString: url });
  });

  it("verifies against the CA and drops the URL's TLS parameters", () => {
    const cfg = pgTlsConfig(
      "postgres://u:p@10.0.0.6:5432/lacaisse?sslmode=verify-full&sslrootcert=/x.pem&application_name=web",
      PEM,
    );
    expect(cfg.ssl).toMatchObject({ ca: `${PEM}\n`, rejectUnauthorized: true });
    const url = new URL(cfg.connectionString);
    expect(url.searchParams.get("sslmode")).toBeNull();
    expect(url.searchParams.get("sslrootcert")).toBeNull();
    expect(url.searchParams.get("application_name")).toBe("web");
    expect(url.host).toBe("10.0.0.6:5432");
  });

  it("refuses a CA value that holds no certificate", () => {
    expect(() => pgTlsConfig("postgres://u:p@h/d", "not a pem")).toThrow(/no PEM certificate/);
  });
});

describe("pgTlsConfig host check", () => {
  // pg sets no TLS servername for an IP host, so Node would check the
  // certificate against "localhost"; the explicit check uses the URL's host.
  const cert = (san: string) => ({ subject: { CN: "db" }, subjectaltname: san }) as never;

  it("accepts a certificate naming the URL's IP, whatever servername Node passes", () => {
    const { ssl } = pgTlsConfig("postgres://u:p@10.0.0.6:5432/d", PEM);
    expect(ssl!.checkServerIdentity("localhost", cert("IP Address:10.0.0.6"))).toBeUndefined();
    expect(ssl!.checkServerIdentity("localhost", cert("IP Address:10.0.0.7"))).toBeInstanceOf(Error);
    expect(ssl!.checkServerIdentity("localhost", cert("DNS:localhost"))).toBeInstanceOf(Error);
  });

  it("checks a DNS host against the DNS names", () => {
    const { ssl } = pgTlsConfig("postgres://u:p@db.internal:5432/d", PEM);
    expect(ssl!.checkServerIdentity("db.internal", cert("DNS:db.internal"))).toBeUndefined();
    expect(ssl!.checkServerIdentity("db.internal", cert("DNS:other.internal"))).toBeInstanceOf(Error);
  });
});

describe("normalizeCaPem", () => {
  it("accepts a PEM whose newlines were flattened to \\n", () => {
    expect(normalizeCaPem(PEM.replace(/\n/g, "\\n"))).toBe(`${PEM}\n`);
  });
});

describe("stripTlsParams", () => {
  it("keeps credentials, host and other parameters", () => {
    expect(stripTlsParams("postgres://a:b@h:1/d?ssl=true&sslmode=disable&x=1")).toBe(
      "postgres://a:b@h:1/d?x=1",
    );
  });
});

describe("malformed URL", () => {
  it("throws an error that carries no part of the URL", () => {
    const secret = "pa55-very-secret";
    const bad = `postgres://user:${secret}@[not-a-host:5432/db`;
    let thrown: unknown;
    try {
      pgTlsConfig(bad, PEM);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & Record<string, unknown>;
    expect(err.message).toBe("The database URL is not a valid URL");
    expect(err.cause).toBeUndefined();
    const everything = JSON.stringify(
      Object.fromEntries(Object.getOwnPropertyNames(err).map((k) => [k, String(err[k])])),
    );
    expect(everything).not.toContain(secret);
    expect(String(err.stack)).not.toContain(secret);
  });
});
