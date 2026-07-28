// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

import type { Fund } from "@/services/db/generated/client";
// From ./host, not ./server: this module is pure (the handler passes the fund
// in), and importing the server façade would drag headers + Prisma into it —
// and into its unit test.
import { getApexUrl, getFundUrl } from "@/services/fund/host";

// How this MCP server introduces itself on `initialize` — the name, logo and
// blurb a client renders in its server list, plus the `instructions` the model
// reads before its first tool call.
//
// Servers are normally registered at a fund's own URL, so the host tells us
// which caisse this connection belongs to (see handler.ts): a fund-registered
// server presents that fund's name and logo, and an apex-registered one falls
// back to the platform's. Only `title` / `description` / `icons` / `websiteUrl`
// change — `name` is the programmatic identifier clients key on and stays
// constant across every host.

const SERVER_NAME = "lacaisse";
const SERVER_VERSION = "1.0.0";
const PLATFORM_TITLE = "La Caisse";

/** The fund columns the server card needs. */
export type IdentityFund = Pick<Fund, "name" | "fullName" | "domain" | "logoUrl">;

// The platform mark, served from public/. Absolute because a client renders it
// far from any request of ours.
function platformIcon() {
  return {
    src: getApexUrl("/logo.png"),
    mimeType: "image/png",
    sizes: ["1024x790"],
  };
}

export function buildServerInfo(fund: IdentityFund | null): Implementation {
  if (!fund) {
    return {
      name: SERVER_NAME,
      title: PLATFORM_TITLE,
      version: SERVER_VERSION,
      description:
        "Operate a La Caisse fund (caisse): members, cards, the fund's token, and merchant payouts. Connected to the platform apex — tools take the fund as an argument.",
      websiteUrl: getApexUrl(),
      icons: [platformIcon()],
    };
  }

  const title = fund.fullName?.trim() || fund.name;
  return {
    name: SERVER_NAME,
    title,
    version: SERVER_VERSION,
    description: `Operate ${title} on La Caisse: members, cards, the fund's token, and merchant payouts.`,
    websiteUrl: getFundUrl(fund.domain),
    // A fund logo is a URL supplied by the fund (same value the branded emails
    // render), so its dimensions and type are unknown to us — omit `sizes` and
    // `mimeType` rather than assert them. Falls back to the platform mark.
    icons: fund.logoUrl ? [{ src: fund.logoUrl }] : [platformIcon()],
  };
}

/**
 * Server-level guidance handed to the model on `initialize` — what this server
 * is, and the two things an agent gets wrong without being told: which fund it
 * is talking to, and that settlement is a sequence ending in an irreversible
 * burn.
 */
export function buildInstructions(fund: IdentityFund | null): string {
  const scope = fund
    ? `This server is connected to ${fund.fullName?.trim() || fund.name} (${fund.domain}). Every tool defaults to that fund, so omit the \`fund\` argument unless you deliberately need another fund the authorized user belongs to.`
    : "This server is connected to the platform apex, which belongs to no single fund, so every fund-scoped tool needs an explicit `fund` domain. Call `list_funds` first to see the ones the authorized user belongs to.";

  return [
    "Operate a La Caisse fund (a 'caisse'): its members, cards, on-chain token, and merchant payouts.",
    scope,
    "Merchant settlement runs in order: list_payout_drafts (what a place is owed) → create_payout → list_payout_orders / fix_payout_orders (clear anything unconfirmed) → pay_payout (returns a bank signing link a person must open) → burn_payout. Burning is irreversible and destroys the merchant's balance, so only burn once the fiat leg is actually paid.",
  ].join("\n\n");
}
