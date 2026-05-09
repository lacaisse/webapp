import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // CLI commands (migrate, db push, studio) connect directly, bypassing the pooler.
    // Runtime PrismaClient uses DATABASE_URL (Supavisor pooler) — see services/db/prisma.ts.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
