// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";
import { pgTlsConfig } from "./tls";

declare global {
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  // PrismaPg disables prepared statement caching by default, which is what
  // Supabase's Supavisor transaction-mode pooler (port 6543) requires.
  // DATABASE_CA_CERT (self-hosted only, services/db/tls.ts) adds TLS with
  // full verification against that CA; unset, the URL goes to pg as is.
  const adapter = new PrismaPg(
    pgTlsConfig(connectionString, process.env.DATABASE_CA_CERT),
  );
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
