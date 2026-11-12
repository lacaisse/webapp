// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { migrationUrlWithCa, normalizeCaPem } from "./release.mjs";

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
