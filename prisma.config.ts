// SPDX-License-Identifier: AGPL-3.0-or-later
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // CLI commands (migrate, db push, studio) use DIRECT_URL — pointed at Supavisor's
    // session-mode pooler (port 5432) so prepared statements and long-lived connections
    // both work. Runtime PrismaClient uses DATABASE_URL (transaction pooler, port 6543)
    // — see services/db/prisma.ts.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
