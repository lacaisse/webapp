// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { z } from "zod";

import { McpToolError } from "./authz";

// Shared plumbing for the MCP toolset — result envelopes, the error guard, and
// the parameter shapes every tool re-uses. Kept apart from the tool modules so
// `tools.ts` and `payout-tools.ts` agree on all of it.

// Optional by design: this MCP server is normally connected to a fund's own
// URL, and requireFundForTool falls back to that fund. Only an apex-connected
// server has to name one.
export const FUND_PARAM = z
  .string()
  .optional()
  .describe(
    'Fund domain, e.g. "paybrussels.lacaisse.eu". Omit to use the fund this server is connected to — only needed when connected to the apex, or to reach another fund you belong to.',
  );

export const ADDRESS = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x wallet address");

export const TX_HASH = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// Tool results are JSON-as-text — structured enough for an agent to reason
// over, human-readable enough to paste into a report.
export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

// CSV field: quote when the value could break the row, double inner quotes.
export function csvCell(value: string | null | undefined): string {
  const s = value ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// Wrap a tool handler so authz failures become tool errors (visible to the
// agent) instead of protocol-level 500s.
export function guarded<A extends unknown[]>(
  fn: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof McpToolError) return fail(e.message);
      console.error("[mcp] tool failed", e);
      return fail("Internal error while running the tool.");
    }
  };
}
