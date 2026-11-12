// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  migrationUrlWithCa,
  migrationUrlWithoutCa,
  normalizeCaPem,
  resolveMigrationUrl,
} from "./release.mjs";

describe("release migrationUrlWithCa", () => {
  it("requires TLS and verifies against the CA file, replacing the URL's TLS settings", () => {
    const url = migrationUrlWithCa(
      "postgres://login:pw@10.0.0.6:5432/lacaisse?sslmode=verify-full&sslrootcert=/elsewhere.pem&connect_timeout=10",
      "/tmp/lacaisse-db-ca-x/ca.pem",
    );
    const u = new URL(url);
    expect(u.searchParams.get("sslmode")).toBe("require");
    expect(u.searchParams.get("sslcert")).toBe("/tmp/lacaisse-db-ca-x/ca.pem");
    expect(u.searchParams.get("sslaccept")).toBe("strict");
    expect(u.searchParams.get("sslrootcert")).toBeNull();
    expect(u.searchParams.get("connect_timeout")).toBe("10");
    expect(`${u.username}:${u.password}@${u.host}${u.pathname}`).toBe(
      "login:pw@10.0.0.6:5432/lacaisse",
    );
  });

  it("refuses a CA value without a certificate", () => {
    expect(() => normalizeCaPem("nope")).toThrow(/no PEM certificate/);
  });
});

describe("release migrationUrlWithoutCa", () => {
  it.each(["require", "verify-ca", "verify-full"])("sslmode=%s gets sslaccept=strict", (mode) => {
    const u = new URL(migrationUrlWithoutCa(`postgres://u:p@db.example.org:5432/d?sslmode=${mode}`));
    expect(u.searchParams.get("sslaccept")).toBe("strict");
    expect(u.searchParams.get("sslmode")).toBe(mode);
  });

  it.each([
    "postgres://u:p@localhost:5432/d",
    "postgres://u:p@localhost:5432/d?sslmode=disable",
    "postgres://u:p@localhost:5432/d?sslmode=prefer",
  ])("leaves %s alone", (url) => {
    expect(migrationUrlWithoutCa(url)).toBe(url);
  });

  it("overrides a weaker sslaccept the URL carried", () => {
    const u = new URL(
      migrationUrlWithoutCa("postgres://u:p@h/d?sslmode=require&sslaccept=accept_invalid_certs"),
    );
    expect(u.searchParams.getAll("sslaccept")).toEqual(["strict"]);
  });
});

describe("release resolveMigrationUrl", () => {
  it("prefers DIRECT_URL, treats empty as unset", () => {
    expect(resolveMigrationUrl({ DIRECT_URL: "postgres://d", DATABASE_URL: "postgres://a" })).toBe("postgres://d");
    expect(resolveMigrationUrl({ DIRECT_URL: "", DATABASE_URL: "postgres://a" })).toBe("postgres://a");
    expect(resolveMigrationUrl({ DIRECT_URL: "  ", DATABASE_URL: "postgres://a" })).toBe("postgres://a");
    expect(resolveMigrationUrl({ DIRECT_URL: "", DATABASE_URL: "" })).toBeNull();
    expect(resolveMigrationUrl({})).toBeNull();
  });
});
