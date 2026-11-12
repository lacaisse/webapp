// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isPlatformPath } from "./platform-paths";

describe("isPlatformPath", () => {
  it.each([
    "/api/health",
    "/api/health/ready",
    "/api/internal/hostname-allowed",
    "/api/maintenance/reencrypt-app-cred",
  ])("passes %s through", (path) => {
    expect(isPlatformPath(path)).toBe(true);
  });

  it.each(["/", "/api/healthz", "/api/healthy", "/api/internal", "/api/cron/topups", "/dashboard"])(
    "classifies %s as usual",
    (path) => {
      expect(isPlatformPath(path)).toBe(false);
    },
  );
});
