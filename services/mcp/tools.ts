// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount, isZeroAddress } from "@/services/alchemy/format";
import { listTransfers } from "@/services/alchemy/transfers";
import { prisma } from "@/services/db/prisma";
import { loadFullAccountHistory } from "@/services/token-audit/history";
import {
  buildBalanceTimeline,
  formatSignedAmount,
  hexToBigInt,
} from "@/services/token-audit/timeline";
import { ANNOTATION_KINDS } from "@/services/transaction-annotation/annotate";

import { McpToolError, requireFundAccessForUser } from "./authz";

// The v1 dashboard toolset for MCP agents. Every fund-scoped tool takes the
// fund's domain and authorizes through requireFundAccessForUser — the
// membership check is the tenant gate (see authz.ts). Role floors mirror the
// dashboard pages: member listing is OPERATOR+, everything token-related is
// ADMIN+ (same as /token).
//
// Tool results are JSON-as-text — structured enough for an agent to reason
// over, human-readable enough to paste into a report.

const FUND_PARAM = z
  .string()
  .describe('Fund domain, e.g. "paybrussels.lacaisse.eu"');
const ADDRESS = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x wallet address");
const TX_HASH = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Wrap a tool handler so authz failures become tool errors (visible to the
// agent) instead of protocol-level 500s.
function guarded<A extends unknown[]>(
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

type TokenFund = {
  tokenAddress: string | null;
  tokenChainId: number | null;
  tokenDecimals: number | null;
  tokenSymbol: string | null;
};

function requireToken(fund: TokenFund) {
  if (!fund.tokenAddress || fund.tokenChainId == null) {
    throw new McpToolError("This fund has no token connected yet.");
  }
  return {
    contractAddress: fund.tokenAddress,
    chainId: fund.tokenChainId,
    decimals: fund.tokenDecimals ?? 0,
    symbol: fund.tokenSymbol,
  };
}

// DB-only address labels (cards, named fund accounts, treasury). Unlike the
// dashboard tables we skip CitizenPay profile/place lookups here — tool calls
// should stay fast and CP-outage-proof; unlabelled addresses come back raw.
async function buildLabels(fund: {
  id: string;
  tokenMinterEoaAddress: string | null;
  tokenMinterSmartAccountAddress: string | null;
}) {
  const [cards, accounts] = await Promise.all([
    prisma.card.findMany({
      where: { fundId: fund.id, account: { not: null } },
      include: { member: { select: { firstName: true, lastName: true } } },
    }),
    prisma.fundTokenAccount.findMany({
      where: { fundId: fund.id, archivedAt: null },
      select: { name: true, address: true },
    }),
  ]);
  const labels = new Map<string, string>();
  for (const c of cards) {
    if (!c.account) continue;
    const member = c.member
      ? `${c.member.firstName} ${c.member.lastName}`.trim()
      : "";
    labels.set(
      c.account.toLowerCase(),
      `card:${c.holderName?.trim() || member || c.serialNumber}`,
    );
  }
  for (const a of accounts) {
    labels.set(a.address.toLowerCase(), `account:${a.name}`);
  }
  if (fund.tokenMinterEoaAddress) {
    labels.set(fund.tokenMinterEoaAddress.toLowerCase(), "treasury:minter");
  }
  if (fund.tokenMinterSmartAccountAddress) {
    labels.set(
      fund.tokenMinterSmartAccountAddress.toLowerCase(),
      "treasury:safe",
    );
  }
  return labels;
}

function label(labels: Map<string, string>, address: string): string {
  const lower = address.toLowerCase();
  if (isZeroAddress(lower)) return "0x0 (mint/burn)";
  const hit = labels.get(lower);
  return hit ? `${lower} (${hit})` : lower;
}

export function registerTools(server: McpServer, ctx: { userId: string }) {
  server.registerTool(
    "list_funds",
    {
      description:
        "List the funds (caisses) the authorized user belongs to, with their role in each. Use the returned domain as the `fund` argument of every other tool.",
      inputSchema: {},
    },
    guarded(async () => {
      const memberships = await prisma.fundMember.findMany({
        where: { userId: ctx.userId },
        include: {
          fund: {
            select: {
              domain: true,
              name: true,
              tokenSymbol: true,
              tokenAddress: true,
            },
          },
        },
      });
      return ok(
        memberships.map((m) => ({
          domain: m.fund.domain,
          name: m.fund.name,
          role: m.role,
          tokenSymbol: m.fund.tokenSymbol,
          hasToken: Boolean(m.fund.tokenAddress),
        })),
      );
    }),
  );

  server.registerTool(
    "list_members",
    {
      description:
        "Search a fund's members (name/email). Requires the OPERATOR role or higher.",
      inputSchema: {
        fund: FUND_PARAM,
        query: z.string().optional().describe("Name or email fragment"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    guarded(async ({ fund: fundDomain, query, limit }) => {
      const { fund } = await requireFundAccessForUser(
        ctx.userId,
        fundDomain,
        "OPERATOR",
      );
      const members = await prisma.member.findMany({
        where: {
          fundId: fund.id,
          ...(query
            ? {
                OR: [
                  { firstName: { contains: query, mode: "insensitive" } },
                  { lastName: { contains: query, mode: "insensitive" } },
                  { email: { contains: query, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        take: limit,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          createdAt: true,
        },
      });
      return ok(members);
    }),
  );

  server.registerTool(
    "list_transfers",
    {
      description:
        "Most recent on-chain transfers of the fund's token, newest first, with card/account/treasury labels where known. Pass the returned nextCursor to page further back. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        cursor: z.string().optional().describe("Opaque cursor from a previous call"),
        pageSize: z.number().int().min(1).max(100).default(25),
      },
    },
    guarded(async ({ fund: fundDomain, cursor, pageSize }) => {
      const { fund } = await requireFundAccessForUser(
        ctx.userId,
        fundDomain,
        "ADMIN",
      );
      const token = requireToken(fund);
      const [page, labels] = await Promise.all([
        listTransfers({
          chainId: token.chainId,
          contractAddress: token.contractAddress,
          pageSize,
          pageKey: cursor ?? null,
        }),
        buildLabels(fund),
      ]);
      return ok({
        transfers: page.transfers.map((tx) => ({
          when: tx.blockTimestamp,
          from: label(labels, tx.from),
          to: label(labels, tx.to),
          amount: formatTokenAmount(tx.rawValue, token.decimals),
          symbol: token.symbol,
          txHash: tx.hash,
        })),
        nextCursor: page.nextPageKey,
      });
    }),
  );

  server.registerTool(
    "account_audit",
    {
      description:
        "Explain a wallet's balance for the fund's token: current balance, totals in/out, a reconciliation verdict (does the transfer history sum to the on-chain balance?), and the most recent timeline entries with running balances. Same math as the dashboard's /token/account page. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        address: ADDRESS,
        recentCount: z.number().int().min(1).max(200).default(25),
      },
    },
    guarded(async ({ fund: fundDomain, address, recentCount }) => {
      const { fund } = await requireFundAccessForUser(
        ctx.userId,
        fundDomain,
        "ADMIN",
      );
      const token = requireToken(fund);
      const account = address.toLowerCase();
      const [history, balances, labels] = await Promise.all([
        loadFullAccountHistory({
          chainId: token.chainId,
          contractAddress: token.contractAddress,
          account,
        }),
        getBalances({
          chainId: token.chainId,
          contractAddress: token.contractAddress,
          addresses: [account],
        }),
        buildLabels(fund),
      ]);
      const currentBalance = hexToBigInt(balances[0]?.rawBalance);
      const timeline = buildBalanceTimeline({
        account,
        currentBalance,
        transfers: history.transfers,
      });
      const fmt = (raw: string) => formatTokenAmount(raw, token.decimals);
      const verdict = !history.complete
        ? "PARTIAL_HISTORY"
        : timeline.openingBalance === BigInt(0)
          ? "RECONCILED"
          : "UNEXPLAINED_DIFFERENCE";
      return ok({
        account: label(labels, account),
        symbol: token.symbol,
        balance: fmt(currentBalance.toString()),
        totalIn: fmt(timeline.totalIn.toString()),
        totalOut: fmt(timeline.totalOut.toString()),
        transferCount: timeline.entries.length,
        verdict,
        unexplained:
          verdict === "UNEXPLAINED_DIFFERENCE"
            ? formatSignedAmount(timeline.openingBalance, fmt)
            : undefined,
        recent: timeline.entries.slice(0, recentCount).map((e) => ({
          when: e.transfer.blockTimestamp,
          direction: e.direction,
          counterparty: label(labels, e.counterparty),
          amount: formatSignedAmount(e.delta, fmt),
          balanceAfter: fmt(e.balanceAfter.toString()),
          txHash: e.transfer.hash,
        })),
      });
    }),
  );

  server.registerTool(
    "annotate_transaction",
    {
      description:
        "Attach (or clear, with an empty note) a free-text note to a transaction hash for this fund. Shows up in the dashboard's token explorer and account audit. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        txHash: TX_HASH,
        note: z.string().max(280),
      },
    },
    guarded(async ({ fund: fundDomain, txHash, note }) => {
      const { fund } = await requireFundAccessForUser(
        ctx.userId,
        fundDomain,
        "ADMIN",
      );
      // Same upsert contract as annotateTransactionAction (the dashboard
      // path): keep any system `kind`, only touch the note; blank clears.
      const hash = txHash.toLowerCase();
      const trimmed = note.trim();
      await prisma.transactionAnnotation.upsert({
        where: { fundId_txHash: { fundId: fund.id, txHash: hash } },
        create: {
          fundId: fund.id,
          txHash: hash,
          kind: ANNOTATION_KINDS.custom,
          note: trimmed || null,
        },
        update: { note: trimmed || null },
      });
      return ok({ ok: true, txHash: hash, note: trimmed || null });
    }),
  );
}
