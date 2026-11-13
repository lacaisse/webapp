// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Fund } from "@/services/db/generated/client";
import * as ops from "@/services/payout/operations";

import { McpToolError, requireFundForTool, type ToolContext } from "./authz";
import { FUND_PARAM, fail, guarded, ok, TX_HASH } from "./tool-kit";

// Merchant settlement (payouts) for MCP agents.
//
// Every tool goes through requireFundForTool (the tenant gate — see authz.ts)
// at ADMIN, the same floor the /payments pages use: the fund is the one this
// server is registered against unless the call names another, and either way
// the token's user must hold ADMIN in it. From there everything hands off to
// services/payout/operations.ts — the same module the dashboard's server
// actions call, so an agent minting, burning, or paying here follows the exact
// same guards and audit trail as an operator clicking the button.
//
// Tenancy of the `payoutId` parameter: payouts live on CitizenPay, not in our
// DB, and every call is made with the fund's OWN encrypted API key
// (getCitizenPayClient(fund)) — a payout id belonging to another treasury
// simply isn't visible to that key. Same trust model as the dashboard's
// /payments/payouts/[id], where the id is equally caller-supplied.
//
// Money-moving tools (fix mode "settle", add_payout_order, burn_payout) say so
// in their description and require an explicit `confirm` — burn_payout above
// all, since it is irreversible from the dashboard too.
//
// Settlement order: create_payout → reconcile (list/fix_payout_orders) →
// pay_payout (creates the bank transfer, returns its signing link; nothing
// leaves the account) → burn_payout → only then the operator signs. Citizen
// Pay marks a payout `complete` within seconds of the bank accepting the
// signed transfer and refuses burn and fee sweep from then on, so the burn
// must be recorded before anyone signs. pay_payout refuses a payout the
// backing check (operations.ts::checkPayoutBacking) can't vouch for unless the
// operator explicitly overrides.
//
// Every result below reports BOTH fee figures, because they are different money
// and an agent that adds them up gets the wrong answer:
//   • `fees` / `payoutFee` on an order, `fees` on a payout — the payment
//     processor's commission, withheld at source. Never in the wallet, never
//     swept.
//   • `payoutFees` — the platform's cut, charged at payout. It IS in the
//     place's wallet and the fee sweep moves it to the treasury.
//   net = total − fees − payoutFees − manualDeduction

const PAYOUT_ID = z.string().min(1).describe("Payout id from list_payouts");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .describe("UTC date, YYYY-MM-DD");

// Agents read English; the operator dashboard reads the operator's locale. Both
// go through the same message catalogue — operations.ts returns already-
// translated strings using whichever translator its caller injects.
async function payoutCtx(
  ctx: ToolContext,
  fundArg: string | undefined,
): Promise<ops.PayoutContext & { fund: Fund }> {
  const [{ fund }, t] = await Promise.all([
    requireFundForTool(ctx, fundArg, "ADMIN"),
    getTranslations({ locale: "en" }),
  ]);
  // Every payout call is a CitizenPay call. In live mode a fund without an API
  // key makes the client factory throw deep inside the operation, which would
  // surface as a bare "internal error" — say what's actually wrong instead.
  // (Mirrors the factory's own condition: no base URL ⇒ mock client, no creds
  // needed.)
  const liveMode = Boolean(process.env.CITIZENPAY_API_BASE_URL);
  if (liveMode && (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc)) {
    throw new McpToolError(
      `${fund.name} is not connected to Citizen Pay yet — no payout data exists until an admin issues an API key in the fund's settings.`,
    );
  }
  return {
    fund,
    userId: ctx.userId,
    t: (key: string, values?: Record<string, string | number>) =>
      t(key as never, values as never),
  };
}

// Ponto only mints a signing link when it's given an https URL to send the
// operator back to after signing, so we build one off the fund's canonical
// domain — the same public "you can close this tab" page the dashboard uses.
function signedRedirectUrl(fund: Fund): string {
  return `https://${fund.domain}/payout-signed`;
}

// The backing report as agents see it (the per-group list of covered
// settlements stays internal; list_payout_orders puts it on the rows).
function backingView(r: ops.PayoutBackingReport) {
  return {
    blocking: r.blocking,
    warnings: r.warnings,
    balance: r.balance,
    duplicates: r.duplicates,
  };
}

// Per order: the other orders sharing its settlement hash, and whether that
// one tx covered them all. Only orders in a shared group appear.
function sharedHashIndex(r: ops.PayoutBackingReport) {
  const out = new Map<number, { sharedTxHashWith: number[]; settlementCoverage: string }>();
  for (const g of r.settlements) {
    for (const id of g.orderIds) {
      out.set(id, {
        sharedTxHashWith: g.orderIds.filter((other) => other !== id),
        settlementCoverage: g.verdict,
      });
    }
  }
  return out;
}

// The order fields an agent needs to reason about an issue, without the opaque
// line-items blob.
function orderRow(o: ops.ClassifiedOrder) {
  return {
    id: o.id,
    status: o.status,
    type: o.type,
    total: o.total,
    // Withheld at source by the processor — the wallet credit is total − fees.
    fees: o.fees,
    // This order's share of the platform cut; in the wallet until the sweep.
    payoutFee: o.payoutFee,
    net: o.net,
    description: o.description,
    payerAccount: o.account,
    txHash: o.txHash,
    completedAt: o.completedAt,
    createdAt: o.createdAt,
    verification: o.verification,
  };
}

export function registerPayoutTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_payout_drafts",
    {
      description:
        "How much each merchant place is currently owed but not yet in a payout — the fund's pending settlement liability, grouped by place, with the order count and the gross / processor fees / platform fees / net split (net = total − fees − payoutFees). This is the answer to \"what's pending for <place>?\": pass `place` to filter to one merchant by name or place id. Only places with a positive net appear. Nothing is created or mutated. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        place: z
          .string()
          .optional()
          .describe(
            "Filter to one place: its id, or a case-insensitive fragment of its name.",
          ),
        from: DATE.optional().describe(
          "Only count orders from this date onwards (inclusive). Omit for all unassigned orders.",
        ),
        to: DATE.optional().describe("Only count orders before this date (exclusive)."),
      },
    },
    guarded(async ({ fund: fundDomain, place, from, to }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const res = await ops.listPayoutDrafts(c, { from, to });
      if ("error" in res) return fail(res.error);

      const needle = place?.trim().toLowerCase();
      const drafts = needle
        ? res.drafts.filter(
            (d) =>
              d.placeId.toLowerCase() === needle ||
              d.placeName.toLowerCase().includes(needle),
          )
        : res.drafts;

      return ok({
        currency: "EUR",
        range: { from: from ?? null, to: to ?? null },
        // Sum across the returned rows so a single-place query reads as one
        // number without the agent having to add anything up.
        pendingNet: drafts
          .reduce((sum, d) => sum + Number(d.net), 0)
          .toFixed(2),
        places: drafts.map((d) => ({
          placeId: d.placeId,
          placeName: d.placeName,
          businessId: d.businessId,
          orderCount: d.orderCount,
          total: d.total,
          fees: d.fees,
          payoutFees: d.payoutFees,
          net: d.net,
        })),
        ...(needle && drafts.length === 0
          ? {
              hint: `No place matched "${place}" with a pending balance. Call list_payout_drafts without \`place\` to see every place that has one.`,
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    "list_payouts",
    {
      description:
        "Payouts that already exist, with their id, place, period, totals and live status: `pending` (created), `payment-pending` (bank transfer created, not yet accepted by the bank), `burnt` (burn recorded), `complete` (Citizen Pay sets it within seconds of the bank accepting the signed transfer, burned or not). The burn must be finished (burn_payout returned success, or status `burnt`) before the transfer is signed; get_payout's `burnOutstanding` flags a `payment-pending` payout where it is not. On a `complete` payout this list cannot tell whether it was burned; get_payout reports `burnRecorded: null` when it cannot either. Use it to find the `payoutId` every other payout tool needs. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        state: z
          .enum(["pending", "completed", "all"])
          .default("pending")
          .describe(
            '"pending" = still to settle (the actionable ones), "completed" = burnt/settled.',
          ),
        place: z
          .string()
          .optional()
          .describe("Filter by place id, or a case-insensitive fragment of the place name."),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    guarded(async ({ fund: fundDomain, state, place, limit }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const res = await ops.listPayouts(c, state);
      if ("error" in res) return fail(res.error);

      const needle = place?.trim().toLowerCase();
      const payouts = (
        needle
          ? res.payouts.filter(
              (p) =>
                p.placeId.toLowerCase() === needle ||
                (p.placeName ?? "").toLowerCase().includes(needle),
            )
          : res.payouts
      ).slice(0, limit);

      return ok({
        currency: "EUR",
        count: payouts.length,
        payouts: payouts.map((p) => ({
          payoutId: p.id,
          placeId: p.placeId,
          placeName: p.placeName,
          status: p.status,
          period: { from: p.startDate, to: p.endDate },
          total: p.totalAmount,
          fees: p.totalFees,
          payoutFees: p.totalPayoutFees,
          manualDeduction: p.manualDeduction,
          net: p.net,
          feeTransferPending: p.feeTransferPending,
          createdAt: p.createdAt,
        })),
      });
    }),
  );

  server.registerTool(
    "create_payout",
    {
      description:
        "Create a pending payout for one place over a date range — atomically claims that place's unassigned orders in `[from, to)`, so they leave the drafts and become a settlement the treasury can pay and burn. Check the amount first with list_payout_drafts. Fails when the range holds no payable orders. The result carries `backing`: whether the place's tokens back the payout (orders sharing one settlement hash that credited less than they claim, a place wallet holding less than settlement removes); read its warnings before paying. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        placeId: z.string().min(1).describe("Place id from list_payout_drafts"),
        from: DATE.describe("Start of the settlement period (inclusive)"),
        to: DATE.describe("End of the settlement period (exclusive)"),
      },
    },
    guarded(async ({ fund: fundDomain, placeId, from, to }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const res = await ops.createPayout(c, { placeId, from, to });
      if ("error" in res) return fail(res.error);
      // Best-effort: the payout exists whatever the check says.
      let backing: ReturnType<typeof backingView> | { error: string };
      try {
        backing = backingView(await ops.checkPayoutBacking(c, res.payoutId));
      } catch (e) {
        console.warn("[mcp] create_payout: backing check failed", e);
        backing = { error: "The backing check could not run; get_payout repeats it." };
      }
      return ok({
        payoutId: res.payoutId,
        orderCount: res.orderCount,
        net: res.net,
        currency: "EUR",
        status: "pending",
        backing,
        hint: "Next: get_payout to review, fix_payout_orders for any unconfirmed orders, then pay_payout (creates the transfer, returns the signing link — do not hand it over yet), then burn_payout, and only once burn_payout has returned success (or get_payout shows status `burnt` with no `burnClaim`) give the operator the signing link.",
      });
    }),
  );

  server.registerTool(
    "get_payout",
    {
      description:
        "Everything about one payout: totals (gross / processor fees withheld at source / platform payout fees / manual deduction / net, where net = total − fees − payoutFees − manualDeduction), the live status, the bank signing link while a payment exists (`payment-pending`), `burnRecorded` (true = evidence of a burn: status `burnt` or a fee sweep done or pending; false = `pending` / `payment-pending` with no such evidence; null = `complete` with no evidence — Citizen Pay does not report burn hashes here, so whether it was burned cannot be determined by this tool), `burnOutstanding` (true only when `payment-pending` with no burn: run burn_payout before the operator signs), whether the retained fee sweep is still outstanding, any burn attempt still in flight (`burnClaim`: never burn, and never let the operator sign, while it is set), and, with `includeOrderCheck`, `backing` while the payout is pending / payment-pending with no burn (warnings, and `blocking` = pay_payout will refuse) and the confirmed / issues split of its orders. A `complete` payout with `burnRecorded: null`: Citizen Pay refuses burn and sweep on it; check the place wallet balance / token history on chain before any manual burn from the token page. Reading the status also nudges settlement forward on CitizenPay's side (an accepted payment completes the payout here). Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        payoutId: PAYOUT_ID,
        includeOrderCheck: z
          .boolean()
          .default(false)
          .describe(
            "Also verify every order's settlement hash on-chain and report the confirmed / issues split, and run the backing check (`backing`). Off by default because it costs one bundler round-trip per handful of orders — on a payout with hundreds of them, prefer list_payout_orders.",
          ),
      },
    },
    guarded(async ({ fund: fundDomain, payoutId, includeOrderCheck }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const detail = await ops.getPayoutDetail(c, payoutId, {
        redirectUrl: signedRedirectUrl(c.fund),
      });
      if ("error" in detail) return fail(detail.error);
      const p = detail.payout;

      let orders: Record<string, unknown> | undefined;
      if (includeOrderCheck) {
        const classified = await ops.classifyPayoutOrders(c, payoutId, {
          // Once settlement has started the orders are locked in — the
          // dashboard stops verifying them too.
          settled: detail.liveStatus !== "pending",
        });
        orders =
          "error" in classified
            ? { error: classified.error }
            : {
                confirmed: classified.confirmed.length,
                issues: classified.issues.length,
                truncated: classified.truncated,
                placeAccount: classified.placeAccountAddress,
                issueIds: classified.issues.map((o) => o.id).slice(0, 100),
              };
      }

      // Evidence-based: the live client never fills burnTxHashes, so an empty
      // list proves nothing. null = complete with no evidence (unknown).
      const burnRecorded = ops.burnRecordedFrom({
        status: detail.liveStatus,
        burnTxHashes: p.burnTxHashes,
        feeTransferTxHash: detail.feeTransferTxHash || p.feeTransferTxHash,
        feeTransferPending: detail.feeTransferPending || p.feeTransferPending,
      });
      const burnOutstanding = burnRecorded === false && detail.liveStatus === "payment-pending";
      // The backing check only on request (it reads every shared hash on
      // chain) and only while it can still change what happens next.
      const backingApplies =
        burnRecorded === false &&
        (detail.liveStatus === "pending" || detail.liveStatus === "payment-pending");
      const backing =
        includeOrderCheck && backingApplies
          ? backingView(
              await ops.checkPayoutBacking(c, payoutId, {
                payout: p,
                status: detail.liveStatus,
              }),
            )
          : undefined;

      return ok({
        payoutId: p.id,
        placeId: p.placeId,
        placeName: p.placeName,
        status: detail.liveStatus,
        period: { from: p.startDate, to: p.endDate },
        currency: "EUR",
        total: p.totalAmount,
        fees: p.totalFees,
        payoutFees: p.totalPayoutFees,
        manualDeduction: p.manualDeduction,
        manualDeductionComment: p.manualDeductionComment,
        net: p.net,
        // Present only while payment-pending: the link the operator opens at
        // their bank to authorise the SEPA transfer.
        signingUrl: detail.signingUrl,
        burnTxHashes: p.burnTxHashes,
        burnRecorded,
        burnOutstanding,
        ...(burnOutstanding
          ? {
              burnHint:
                "No burn is recorded yet: run burn_payout now, and do not let the operator sign the transfer until it has succeeded.",
            }
          : burnRecorded === null
            ? {
                burnHint:
                  "Complete, and whether it was burned cannot be determined from this tool (Citizen Pay does not report burn hashes here). Citizen Pay refuses burn_payout and sweep_payout_fees on a complete payout. Before any manual burn from the token page, check the place wallet balance and token history on chain against this payout's net + retained cut.",
              }
            : {}),
        feeTransferPending: detail.feeTransferPending,
        feeTransferTxHash: detail.feeTransferTxHash,
        // Non-null while a burn attempt holds the payout and nothing is
        // recorded yet: do not burn — an admin resolves it on the payout page.
        burnClaim: detail.burnClaim,
        emailRecipient: p.emailRecipient,
        emailSentAt: p.emailSentAt,
        ...(backing ? { backing } : {}),
        orders,
        ...(orders
          ? {}
          : {
              hint: backingApplies
                ? "The backing check did not run: call get_payout with `includeOrderCheck: true`, or list_payout_orders (per-order breakdown, on-chain verification of each one, and `backing`)."
                : "Call list_payout_orders for the per-order breakdown and the on-chain verification of each one.",
            }),
      });
    }),
  );

  server.registerTool(
    "list_payout_orders",
    {
      description:
        "The orders inside a payout, each with its on-chain verification verdict. `filter: \"issues\"` returns exactly the orders that failed verification — a sale with no settlement hash, or a hash that never mined / reverted — which is what fix_payout_orders acts on. A refund / correction / topup leg is the subtract side of the payout (it nets a refunded sale out); one without a hash is a ledger entry and counts as confirmed, never an issue. \"Confirmed\" only means the hash mined: several orders can carry the SAME hash. Such orders get `sharedTxHashWith` (the other order ids) and `settlementCoverage` (`covered` = that one tx credited the place what they all claim, `uncovered` = it did not — likely duplicate rows that would overpay the merchant, `unverified` = its transfers could not be read), and the top-level `backing` summarises it with the place wallet's balance. Read-only. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        payoutId: PAYOUT_ID,
        filter: z.enum(["issues", "confirmed", "all"]).default("issues"),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    guarded(async ({ fund: fundDomain, payoutId, filter, limit }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const status = await ops.getPayoutStatus(c, payoutId);
      if ("error" in status) return fail(status.error);

      const classified = await ops.classifyPayoutOrders(c, payoutId, {
        settled: status.status !== "pending",
      });
      if ("error" in classified) return fail(classified.error);

      const backing = await ops.checkPayoutBacking(c, payoutId, {
        status: status.status,
        orders: {
          orders: [...classified.confirmed, ...classified.issues],
          placeAccountAddress: classified.placeAccountAddress,
          truncated: classified.truncated,
        },
      });
      const shared = sharedHashIndex(backing);

      const pool =
        filter === "issues"
          ? classified.issues
          : filter === "confirmed"
            ? classified.confirmed
            : [...classified.confirmed, ...classified.issues];

      return ok({
        payoutStatus: status.status,
        placeAccount: classified.placeAccountAddress,
        counts: {
          confirmed: classified.confirmed.length,
          issues: classified.issues.length,
        },
        truncated: classified.truncated,
        backing: backingView(backing),
        returned: Math.min(pool.length, limit),
        orders: pool.slice(0, limit).map((o) => ({
          ...orderRow(o),
          ...(shared.get(o.id) ?? {}),
        })),
        ...(pool.length > limit
          ? { hint: `${pool.length - limit} more order(s) not shown — raise \`limit\` to see them.` }
          : {}),
      });
    }),
  );

  server.registerTool(
    "fix_payout_orders",
    {
      description:
        "Reconcile the orders sitting in a payout's Issues list. Modes:\n" +
        '• "automatch" (default, safe) — find each order\'s real settlement transfer already on-chain and record its hash. Nothing is minted or burned. Try this first; it clears most issues.\n' +
        '• "record" — record one operator-supplied `txHash` on one order. Nothing moves on-chain.\n' +
        '• "settle" — MOVES TOKENS: burns the order total from the payer (when it has one) and mints the net to the place, then records the mint. Use only for orders that genuinely never settled, e.g. a bank-paid order whose transfer you have verified landed. Requires `confirm: true`.\n' +
        '• "archive" — drop the orders out of the payout and recompute its totals. Use when an order should not be paid at all. Refused for a refund / correction / topup leg: dropping one overpays the merchant.\n' +
        "Only works while the payout is pending. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        payoutId: PAYOUT_ID,
        mode: z.enum(["automatch", "record", "settle", "archive"]).default("automatch"),
        orderIds: z
          .array(z.number().int().positive())
          .optional()
          .describe(
            "Orders to act on. Omit with mode \"automatch\" to run over every current issue; required for the other modes.",
          ),
        txHash: TX_HASH.optional().describe(
          'Settlement hash to record — mode "record" only, with exactly one order id.',
        ),
        confirm: z
          .boolean()
          .optional()
          .describe('Required (true) for mode "settle", which mints and burns real tokens.'),
      },
    },
    guarded(async ({ fund: fundDomain, payoutId, mode, orderIds, txHash, confirm }) => {
      const c = await payoutCtx(ctx, fundDomain);

      const status = await ops.getPayoutStatus(c, payoutId);
      if ("error" in status) return fail(status.error);
      if (status.status !== "pending") {
        return fail(
          `This payout is ${status.status}; its orders are locked in and can no longer be reconciled.`,
        );
      }

      const classified = await ops.classifyPayoutOrders(c, payoutId);
      if ("error" in classified) return fail(classified.error);

      // Act on the named orders, or (automatch only) on everything currently in
      // Issues. Ids that aren't in this payout are reported, not silently dropped.
      const all = [...classified.confirmed, ...classified.issues];
      const byId = new Map(all.map((o) => [o.id, o]));
      const unknownIds = (orderIds ?? []).filter((id) => !byId.has(id));
      if (unknownIds.length > 0) {
        return fail(
          `Order(s) ${unknownIds.join(", ")} are not part of payout ${payoutId}.`,
        );
      }
      const targets = orderIds
        ? orderIds.map((id) => byId.get(id)!)
        : mode === "automatch"
          ? classified.issues
          : [];

      if (mode !== "automatch" && targets.length === 0) {
        return fail("Pass `orderIds` — this mode never acts on the whole payout.");
      }

      if (mode === "automatch") {
        if (targets.length === 0) {
          return ok({ fixed: [], unresolved: [], note: "No unconfirmed orders to fix." });
        }
        const res = await ops.autoMatchOrders(c, {
          payoutId,
          placeAccount: classified.placeAccountAddress,
          orders: targets.map((o) => ({
            id: o.id,
            status: o.status,
            account: o.account,
            total: o.total,
            net: o.net,
            completedAt: o.completedAt,
            createdAt: o.createdAt,
          })),
        });
        return ok({
          attempted: targets.length,
          fixed: res.fixed,
          unresolved: res.unresolved,
          hint:
            res.unresolved.length > 0
              ? 'Still unresolved: "nomatch"/"truncated" = no on-chain transfer found (it may genuinely never have settled — check with list_payout_orders, then mode "settle" or "archive"); "ambiguous" = several candidate transfers, record the right one with mode "record".'
              : undefined,
        });
      }

      if (mode === "record") {
        if (targets.length !== 1) {
          return fail('Mode "record" takes exactly one order id.');
        }
        if (!txHash) return fail('Mode "record" requires `txHash`.');
        const res = await ops.fixOrder(c, {
          payoutId,
          orderId: targets[0].id,
          account: targets[0].account,
          placeAccount: classified.placeAccountAddress,
          total: targets[0].total,
          net: targets[0].net,
          txHash,
        });
        return "error" in res
          ? fail(res.error)
          : ok({ orderId: targets[0].id, recordedTxHash: res.txHash });
      }

      if (mode === "settle") {
        if (confirm !== true) {
          return fail(
            'Mode "settle" mints and burns real tokens — re-run with `confirm: true` once the operator has agreed.',
          );
        }
        const results: unknown[] = [];
        for (const o of targets) {
          const res = await ops.fixOrder(c, {
            payoutId,
            orderId: o.id,
            account: o.account,
            placeAccount: classified.placeAccountAddress,
            total: o.total,
            net: o.net,
          });
          results.push(
            "error" in res
              ? { orderId: o.id, ok: false, error: res.error }
              : { orderId: o.id, ok: true, txHash: res.txHash },
          );
        }
        return ok({ mode: "settle", results });
      }

      const archived = await ops.archiveOrders(c, {
        payoutId,
        orderIds: targets.map((o) => o.id),
      });
      return ok({ mode: "archive", results: archived });
    }),
  );

  server.registerTool(
    "set_payout_deduction",
    {
      description:
        "Set or clear a payout's manual deduction — a ledger adjustment that lowers the net the merchant is paid (net = total − fees − payoutFees − deduction), with a comment explaining why. Pure bookkeeping on the payout's ledger; the deducted tokens leave the merchant's wallet with the platform fees at the settlement sweep. Pass amount \"0\" to clear it. Only while the payout is pending, and never more than total − fees − payoutFees. To adjust the payout UPWARDS, add an order with add_payout_order instead. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        payoutId: PAYOUT_ID,
        amount: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, "EUR amount, up to 2 decimals")
          .describe('EUR decimal, e.g. "12.50". "0" clears the deduction.'),
        comment: z
          .string()
          .max(500)
          .optional()
          .describe("Why the deduction exists — shown to the operator on the payout."),
      },
    },
    guarded(async ({ fund: fundDomain, payoutId, amount, comment }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const res =
        Number(amount) === 0
          ? await ops.clearManualDeduction(c, payoutId)
          : await ops.setManualDeduction(c, {
              payoutId,
              amount,
              comment: comment ?? null,
            });
      if ("error" in res) return fail(res.error);
      return ok({
        payoutId: res.payout.payoutId,
        currency: "EUR",
        total: res.payout.total,
        fees: res.payout.fees,
        payoutFees: res.payout.payoutFees,
        manualDeduction: res.payout.manualDeduction,
        manualDeductionComment: res.payout.manualDeductionComment,
        net: res.payout.net,
      });
    }),
  );

  server.registerTool(
    "add_payout_order",
    {
      description:
        "Add a manual order to a pending payout — an amount that exists outside CitizenPay (a bank transfer reconciled by hand, an agreed correction). It raises the payout's total, and MOVES TOKENS: the order's wallet credit (total − fees) is immediately minted to the place's wallet, mirroring how a real order settles. `payoutFee` is not withheld now — it is minted with the credit and swept to the treasury at settlement. Only while the payout is pending. To lower a payout instead, use set_payout_deduction. Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        payoutId: PAYOUT_ID,
        total: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, "EUR amount, up to 2 decimals")
          .describe("Gross amount in EUR"),
        fees: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, "EUR amount, up to 2 decimals")
          .default("0")
          .describe(
            "Processor commission already withheld at source, so it never reached the wallet. \"0\" for a bank transfer or any amount received in full.",
          ),
        payoutFee: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, "EUR amount, up to 2 decimals")
          .default("0")
          .describe(
            "The platform's own cut on this order, charged at payout and swept from the place's wallet at settlement. Together with `fees` it cannot exceed `total`.",
          ),
        description: z
          .string()
          .max(500)
          .optional()
          .describe("What this order is — e.g. the bank-transfer reference."),
        confirm: z
          .boolean()
          .optional()
          .describe("Required (true): creating the order mints tokens to the place."),
      },
    },
    guarded(async ({ fund: fundDomain, payoutId, total, fees, payoutFee, description, confirm }) => {
      if (confirm !== true) {
        return fail(
          "Adding an order mints real tokens to the place — re-run with `confirm: true` once the operator has agreed.",
        );
      }
      const c = await payoutCtx(ctx, fundDomain);
      const res = await ops.createPayoutOrder(c, {
        payoutId,
        total,
        fees,
        payoutFee,
        description: description ?? null,
      });
      if ("error" in res) return fail(res.error);
      return ok({
        orderId: res.order.id,
        currency: "EUR",
        order: {
          total: res.order.total,
          fees: res.order.fees,
          payoutFee: res.order.payoutFee,
          // What was minted to the place: total − fees.
          net: res.order.net,
        },
        payoutTotals: {
          total: res.payout.total,
          fees: res.payout.fees,
          payoutFees: res.payout.payoutFees,
          net: res.payout.net,
        },
        ...("txHash" in res
          ? { mintTxHash: res.txHash }
          : {
              mintError: res.mintError,
              hint: "The order exists but its mint failed — it will show in Issues. Do NOT re-add it; reconcile with fix_payout_orders.",
            }),
      });
    }),
  );

  server.registerTool(
    "pay_payout",
    {
      description:
        "Create the fiat leg: ask CitizenPay to create the SEPA bank transfer paying the merchant this payout's net, and return the bank signing link. Nothing leaves the account until a human signs at the bank — and the operator must NOT sign yet: run burn_payout first (it works while the payout is `payment-pending`). Citizen Pay marks the payout complete within seconds of the bank accepting the signed transfer and then refuses the burn. Before creating anything it checks that the place's tokens back the payout (orders sharing one settlement hash that credited less than they claim; a place wallet holding less than net + retained cut; anything it could not read) and refuses, creating nothing, when they don't; the refusal lists every warning. Set `overrideBackingCheck: true` only after the operator has seen those warnings and explicitly agreed to pay anyway. Safe to call again — if a payment already exists you get the existing link back rather than a second transfer (after the same backing check). Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        payoutId: PAYOUT_ID,
        overrideBackingCheck: z
          .boolean()
          .optional()
          .describe(
            "Pay even though the backing check found problems. Only after the operator has seen the warnings and explicitly agreed.",
          ),
      },
    },
    guarded(async ({ fund: fundDomain, payoutId, overrideBackingCheck }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const res = await ops.createPayoutPayment(c, payoutId, {
        redirectUrl: signedRedirectUrl(c.fund),
        allowUnbacked: overrideBackingCheck === true,
      });
      if ("error" in res) {
        if (res.backing?.blocking) {
          return fail(
            [
              "No bank payment was created: the payout is not provably backed by the place's tokens.",
              ...res.backing.warnings.map((w) => `- ${w}`),
              "Fix the orders (fix_payout_orders mode \"archive\" for duplicate rows; list_payout_orders shows `sharedTxHashWith` / `settlementCoverage`) or, only if the operator has seen these warnings and explicitly agrees to pay anyway, call pay_payout again with `overrideBackingCheck: true`.",
            ].join("\n"),
          );
        }
        return fail(res.error);
      }
      return ok({
        payoutId,
        alreadyCreated: res.alreadyCreated,
        paymentId: res.paymentId,
        signingUrl: res.signingUrl,
        ...(res.backing.warnings.length > 0 ? { backing: backingView(res.backing) } : {}),
        hint: res.signingUrl
          ? "Do NOT give this link to the operator yet: run burn_payout now, and hand the link over only once burn_payout has returned success (or get_payout shows status `burnt` with no `burnClaim`). The transfer only goes out once they sign it at their bank."
          : "No signing link came back. Re-read get_payout: the payment may already be signed, or the bank connection may not have payment initiation enabled. If the status is still payment-pending (`burnOutstanding`), run burn_payout.",
      });
    }),
  );

  server.registerTool(
    "burn_payout",
    {
      description:
        "IRREVERSIBLE. Burn the tokens backing a payout: destroys the payout's net from the merchant place's wallet with the fund's minter, reports the burn to CitizenPay (which marks the payout burnt), and sweeps the retained cut — the platform payout fees plus any manual deduction — to the fund's treasury account. Processor fees withheld at source are in neither figure; they never entered the wallet. Works while the payout is `pending` or `payment-pending`. Run it right after pay_payout and BEFORE the operator signs the transfer: Citizen Pay marks the payout `complete` within seconds of the bank accepting it and from then on refuses both the burn and the fee sweep. Never let the operator sign while this is running or while get_payout shows a `burnClaim`. A payout already `complete` cannot be burned here: with no evidence of a burn it answers that whether it was burned cannot be confirmed here, and the place wallet must be checked on chain (balance / token history) before an admin burns by hand from the token page. Refuses, burning nothing, when the place's wallet holds less than settlement removes (net + retained cut) — top up the place or adjust the deduction first. A second call is rejected — the burn first takes Citizen Pay's burn claim, so only one attempt can run. If it fails saying the burn may have been sent or another attempt is in progress, do NOT retry: an admin checks the chain and records or releases the attempt from the payout page. A timeout or dropped connection does NOT mean the burn failed — the burn can take over a minute and may still land. Never call this again after an unclear outcome; read get_payout instead (status `burnt`, or a non-null `burnClaim` = an attempt still in flight). Requires ADMIN.",
      inputSchema: {
        fund: FUND_PARAM,
        payoutId: PAYOUT_ID,
        confirm: z
          .literal(true)
          .describe(
            "Must be true. Confirm with the operator first — burning cannot be undone.",
          ),
      },
    },
    guarded(async ({ fund: fundDomain, payoutId }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const res = await ops.burnPayout(c, payoutId);
      if ("error" in res) return fail(res.error);
      return ok({
        payoutId,
        burnTxHash: res.txHash,
        feeAmount: res.feeAmount ?? null,
        feeTransferTxHash: res.feeTransferTxHash ?? null,
        feeTransferPending: res.feeTransferPending ?? false,
        feeTransferError: res.feeTransferError ?? null,
        // The burn is recorded; something after it on our side failed.
        warning: res.warning ?? null,
        hint: res.feeTransferPending
          ? "The burn succeeded but the fee sweep did not run — retry it with sweep_payout_fees. Do NOT call burn_payout again."
          : undefined,
      });
    }),
  );

  server.registerTool(
    "sweep_payout_fees",
    {
      description:
        "Run (or retry) just the fee sweep on a payout whose burn is recorded — moves the retained cut (the platform payout fees plus any manual deduction) from the place's wallet to the fund's treasury account. Needs a recorded burn: refused on a payout without one, and on a `complete` payout with none it can never succeed (Citizen Pay no longer accepts the burn there). Idempotent: if an earlier sweep already went through you get that transfer back instead of a second one. Use it when burn_payout reported `feeTransferPending`. Requires ADMIN.",
      inputSchema: { fund: FUND_PARAM, payoutId: PAYOUT_ID },
    },
    guarded(async ({ fund: fundDomain, payoutId }) => {
      const c = await payoutCtx(ctx, fundDomain);
      const res = await ops.feeTransfer(c, payoutId);
      if ("error" in res) return fail(res.error);
      return ok({
        payoutId,
        feeTransferTxHash: res.feeTransferTxHash,
        feeAmount: res.feeAmount,
        alreadyTransferred: res.alreadyTransferred,
      });
    }),
  );
}
