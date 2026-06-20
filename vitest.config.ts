// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Unit-test runner for pure logic (where-clause builders, parsers, crypto
// envelope helpers, etc.). Component/integration tests can be layered on later
// with a jsdom environment per-file via the `// @vitest-environment jsdom`
// pragma. The generated Prisma client and build output are excluded so we only
// ever test our own source.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "node_modules/**",
      ".next/**",
      "services/db/generated/**",
    ],
  },
});
