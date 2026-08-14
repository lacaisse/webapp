// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/services/db/prisma";

// The current fund (caisse) is identified by the request host. proxy.ts
// performs the lookup against `Fund.domain` and forwards `x-fund-domain` +
// `x-fund-id`. App code reads the fund through these helpers — never
// re-parse the host or query the DB directly for the current fund.

export const getCurrentFundDomain = cache(async () => {
  const h = await headers();
  return h.get("x-fund-domain");
});

export const getCurrentFund = cache(async () => {
  const h = await headers();
  const fundId = h.get("x-fund-id");
  if (!fundId) return null;
  return prisma.fund.findUnique({ where: { id: fundId } });
});

export const requireCurrentFund = cache(async () => {
  const fund = await getCurrentFund();
  if (!fund) notFound();
  return fund;
});

// The URL builders are pure host arithmetic and live in ./host.ts, which
// pulls in neither headers nor Prisma. They're re-exported here so app code
// keeps one import site for everything fund-related (AGENTS.md) — callers that
// must stay out of the server-only graph import them from ./host directly.
export { getApexUrl, getFundUrl } from "./host";
