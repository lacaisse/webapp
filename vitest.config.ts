// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Unit-test runner for pure logic (where-clause builders, parsers, crypto
// envelope helpers, etc.). Component/integration tests can be layered on later
// with a jsdom environment per-file via the `// @vitest-environment jsdom`
// pragma. The generated Prisma client and build output are excluded so we only
// ever test our own source.
//
// `@/*` mirrors the tsconfig path alias so a test can import a module the same
// way the app does. Note CI runs `npm run test` with no env: a module that
// reaches `@/services/db/prisma` throws "DATABASE_URL is not set" the moment
// it's imported, so keep the unit under test on the pure side of the graph
// (e.g. services/fund/host.ts, not services/fund/server.ts) rather than
// stubbing the database in.
export default defineConfig({
  resolve: {
    alias: { "@": resolve(import.meta.dirname, ".") },
  },
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
