// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount, isZeroAddress } from "@/services/alchemy/format";
import {
  listTransfers,
  type AlchemyTransfer,
} from "@/services/alchemy/transfers";
import { prisma } from "@/services/db/prisma";
import { resolveAddresses } from "@/services/profile/resolve";
import { loadFullAccountHistory } from "@/services/token-audit/history";
import {
  buildBalanceTimeline,
  formatSignedAmount,
  hexToBigInt,
} from "@/services/token-audit/timeline";
import {
  ANNOTATION_KINDS,
  getAnnotations,
  type TxAnnotation,
} from "@/services/transaction-annotation/annotate";

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

// One list_transfers call returns at most this many rows — a bound on the
// response an agent has to read and on how long the request can run. The whole
// history is still reachable: a capped call says so in `complete`/`hint` and
// hands back the cursor to continue from.
const MAX_TRANSFERS_PER_CALL = 1000;
const DEFAULT_TRANSFERS_PER_CALL = 100;
// Upstream page size. Alchemy's own per-request cap is 1000.
const TRANSFER_FETCH_PAGE = 1000;
// Bulk pulls fan out into IN-lists; keep every query well under Postgres's
// bind-parameter limit and CP's batch cap.
const LOOKUP_CHUNK = 500;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

// CSV field: quote when the value could break the row, double inner quotes.
function csvCell(value: string | null | undefined): string {
  const s = value ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
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
// An agent that wants the full picture for a handful of addresses calls
// `resolve_addresses`, which does hit CP (through the persisted cache).
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

// The dashboard's full-fidelity labelling for a known set of addresses: the DB
// labels above, plus CitizenPay place / profile names for whatever is left —
// what the token table shows. One CP round-trip at most, absorbed by
// AddressProfileCache, and `resolveAddresses` degrades to local-only labels
// when CP is down.
async function buildRichLabels(
  fund: Parameters<typeof buildLabels>[0] & {
    citizenPayApiKeyId: string | null;
    citizenPayApiKeyEnc: string | null;
  },
  addresses: string[],
) {
  // Dedupe before chunking: a full-history pull hands us two addresses per
  // transfer, and the same wallets recur on nearly every row.
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const [labels, resolvedChunks] = await Promise.all([
    buildLabels(fund),
    Promise.all(
      chunk(unique, LOOKUP_CHUNK).map((slice) => resolveAddresses(fund, slice)),
    ),
  ]);
  // DB labels win — a local card/account name is more specific than whatever
  // CP holds for the same address.
  for (const resolved of resolvedChunks) {
    for (const place of resolved.places) {
      if (!labels.has(place.account)) {
        labels.set(place.account, `place:${place.name}`);
      }
    }
    for (const profile of resolved.profiles) {
      const name = profile.name?.trim() || profile.username?.trim();
      if (name && !labels.has(profile.account)) {
        labels.set(profile.account, `profile:${name}`);
      }
    }
  }
  return labels;
}

// getAnnotations in bounded IN-lists, merged. Same contract as the single
// call: a Map keyed by lowercased tx hash.
async function annotationsFor(fundId: string, txHashes: string[]) {
  const unique = [...new Set(txHashes.map((h) => h.toLowerCase()))];
  const maps = await Promise.all(
    chunk(unique, LOOKUP_CHUNK).map((slice) => getAnnotations(fundId, slice)),
  );
  const merged = new Map<string, TxAnnotation>();
  for (const map of maps) {
    for (const [hash, annotation] of map) merged.set(hash, annotation);
  }
  return merged;
}

// The label on its own ("card:Ana Duarte"), or "" when the address is
// unlabelled. Separate from `label` so CSV can put it in its own column.
function labelText(labels: Map<string, string>, address: string): string {
  const lower = address.toLowerCase();
  if (isZeroAddress(lower)) return "mint/burn";
  return labels.get(lower) ?? "";
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
        "On-chain transfers of the fund's token, newest first — the same list the dashboard's token page shows, including each transfer's annotation (kind, trigger, acting admin, note) and card / account / treasury / place / profile labels for both sides. Returns at most `limit` transfers (max 1000) per call. To pull the token's entire history, keep calling with the returned `nextCursor` until `complete` is true — `complete: false` always means there is older history left, and the response's `hint` spells out the exact next call. `format: \"csv\"` costs a fraction of the JSON in tokens and is the better choice when walking many pages. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        cursor: z
          .string()
          .optional()
          .describe(
            "nextCursor from a previous call. Omit to start at the newest transfer.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRANSFERS_PER_CALL)
          .default(DEFAULT_TRANSFERS_PER_CALL)
          .describe(
            `Max transfers to return in this call (1-${MAX_TRANSFERS_PER_CALL}). Upstream paging is handled internally to reach it.`,
          ),
        format: z
          .enum(["json", "csv"])
          .default("json")
          .describe(
            'Row encoding. "csv" (columns: when,from,fromLabel,to,toLabel,amount,symbol,txHash,kind,trigger,triggeredBy,note) is much cheaper for a full-history pull.',
          ),
      },
    },
    guarded(async ({ fund: fundDomain, cursor, limit, format }) => {
      const { fund } = await requireFundAccessForUser(
        ctx.userId,
        fundDomain,
        "ADMIN",
      );
      const token = requireToken(fund);

      // Walk upstream pages until we have `limit` rows or the cursor runs
      // dry — one tool call is one usable chunk regardless of how the upstream
      // cursor happens to split it. An empty page is the runaway guard:
      // upstream handing back a cursor forever without rows must not loop.
      const transfers: AlchemyTransfer[] = [];
      let pageKey = cursor ?? null;
      let complete = false;
      while (transfers.length < limit) {
        const page = await listTransfers({
          chainId: token.chainId,
          contractAddress: token.contractAddress,
          pageSize: Math.min(limit - transfers.length, TRANSFER_FETCH_PAGE),
          pageKey,
        });
        transfers.push(...page.transfers);
        pageKey = page.nextPageKey;
        if (!pageKey || page.transfers.length === 0) {
          complete = !pageKey;
          break;
        }
      }

      const [labels, annotations] = await Promise.all([
        buildRichLabels(
          fund,
          transfers.flatMap((tx) => [tx.from, tx.to]),
        ),
        annotationsFor(
          fund.id,
          transfers.map((tx) => tx.hash),
        ),
      ]);

      const rows = transfers.map((tx) => {
        const annotation = annotations.get(tx.hash.toLowerCase());
        return {
          when: tx.blockTimestamp,
          from: tx.from.toLowerCase(),
          to: tx.to.toLowerCase(),
          amount: formatTokenAmount(tx.rawValue, token.decimals),
          txHash: tx.hash,
          // Annotation columns from the dashboard table.
          kind: annotation?.kind ?? null,
          trigger: annotation?.trigger ?? null,
          triggeredBy: annotation?.triggeredByName ?? null,
          note: annotation?.note ?? null,
        };
      });

      const meta = {
        count: rows.length,
        // True once the cursor ran dry — nothing older than the last row
        // exists. False means the call stopped at `limit`.
        complete,
        nextCursor: pageKey,
        symbol: token.symbol,
        // Spelled out rather than left implicit in `complete`: a capped call
        // is the normal way to read a long history, and the caller shouldn't
        // have to infer that more exists or how to ask for it.
        hint: complete
          ? undefined
          : `Older transfers remain. Call list_transfers again with cursor="${pageKey}" (same fund, limit up to ${MAX_TRANSFERS_PER_CALL}) and repeat until complete is true.`,
      };

      if (format === "csv") {
        const header =
          "when,from,fromLabel,to,toLabel,amount,symbol,txHash,kind,trigger,triggeredBy,note";
        const body = rows.map((r) =>
          [
            r.when,
            r.from,
            labelText(labels, r.from),
            r.to,
            labelText(labels, r.to),
            r.amount,
            token.symbol,
            r.txHash,
            r.kind,
            r.trigger,
            r.triggeredBy,
            r.note,
          ]
            .map(csvCell)
            .join(","),
        );
        // Metadata and rows as separate content blocks — embedding the CSV in
        // a JSON string would escape every newline and undo the saving.
        return {
          content: [
            { type: "text", text: JSON.stringify(meta) },
            { type: "text", text: [header, ...body].join("\n") },
          ],
        };
      }

      return ok({
        ...meta,
        transfers: rows.map((r) => ({
          when: r.when,
          from: label(labels, r.from),
          to: label(labels, r.to),
          amount: r.amount,
          symbol: token.symbol,
          txHash: r.txHash,
          // Omitted entirely when the transfer carries no annotation.
          kind: r.kind ?? undefined,
          trigger: r.trigger ?? undefined,
          triggeredBy: r.triggeredBy ?? undefined,
          note: r.note ?? undefined,
        })),
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
      const [history, balances] = await Promise.all([
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
      ]);
      // Labels wait on the history — the counterparties to resolve are exactly
      // the addresses it turned up.
      const labels = await buildRichLabels(fund, [
        account,
        ...history.transfers.flatMap((tx) => [tx.from, tx.to]),
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
    "resolve_addresses",
    {
      description:
        "Identify on-chain addresses: each one resolves to a fund card (with holder name), a merchant place, or a CitizenPay profile (name, username, avatar) for external wallets — or `unknown` when nothing matches. Same 3-tier resolution the dashboard uses to label transfers, so feed it the addresses returned by list_transfers or account_audit. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        addresses: z
          .array(ADDRESS)
          .min(1)
          .max(100)
          .describe("Wallet addresses to look up, in any order"),
      },
    },
    guarded(async ({ fund: fundDomain, addresses }) => {
      const { fund } = await requireFundAccessForUser(
        ctx.userId,
        fundDomain,
        "ADMIN",
      );
      const resolved = await resolveAddresses(fund, addresses);

      const byAccount = new Map<string, Record<string, unknown>>();
      for (const c of resolved.cards) {
        byAccount.set(c.account, {
          kind: "card",
          name: c.name,
          cardId: c.cardId,
          serialNumber: c.serialNumber,
        });
      }
      for (const p of resolved.places) {
        byAccount.set(p.account, {
          kind: "place",
          name: p.name,
          merchantId: p.merchantId,
        });
      }
      for (const p of resolved.profiles) {
        byAccount.set(p.account, {
          kind: "profile",
          name: p.name || null,
          username: p.username || null,
          description: p.description || null,
          image: p.image,
          parent: p.parent,
        });
      }

      // One entry per requested address, in request order — duplicates and
      // mixed casing included, so the agent can zip the result back onto
      // whatever list it started from.
      return ok(
        addresses.map((raw) => {
          const account = raw.toLowerCase();
          if (isZeroAddress(account)) {
            return { account, kind: "zero", name: "mint/burn" };
          }
          return {
            account,
            ...(byAccount.get(account) ?? { kind: "unknown" }),
          };
        }),
      );
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
