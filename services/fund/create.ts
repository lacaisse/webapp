// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { Prisma } from "@/services/db/generated/client";
import { generateFundMinter } from "@/services/token/minter";

import { FUND_APEX } from "./host";

// The one place a Fund row is written at creation, inside whatever
// transaction the caller runs: createFundAction (/new, with or without a
// waiver code) and the apex /join door (services/fund-setup/join-actions.ts),
// which creates the owner's account in the same transaction.

// A waiver code opened the door: the fund starts waived, the code's label is
// the reason the fund reads on Settings → Subscription, and the fund remembers
// it was CREATED with the code (Fund.createdWithWaiverCodeId), which is how
// /admin/waivers tells a created fund from one that redeemed the code later.
export type NewFundWaiver = { codeId: string; label: string };

export type NewFundArgs = {
  name: string;
  subdomain: string;
  // The creator's session locale when supported, else the schema default.
  defaultLocale?: string;
  ownerUserId: string;
  now: Date;
  waiver?: NewFundWaiver;
};

/** `Fund.domain` for a free fund: the subdomain under the production apex. */
export function fundDomainFor(subdomain: string): string {
  return `${subdomain}.${FUND_APEX}`;
}

export async function createFundRecord(tx: Prisma.TransactionClient, args: NewFundArgs) {
  // Mint the per-fund token-minter keypair upfront so every fund has a
  // signing identity for UserOp-based mint/burn from day one — see
  // services/token/minter.ts. The smart-account address is derived later
  // (in services/citizenpay/connect.ts::consumeConnect) once CP returns
  // the per-treasury factory address.
  const minter = generateFundMinter();

  // One nested create. Default tier values come from the scoping doc's
  // example (5.3.1): min €100 / target €150 / max €225 — admin can edit
  // amounts and add more tiers from the settings UI.
  return tx.fund.create({
    data: {
      name: args.name,
      domain: fundDomainFor(args.subdomain),
      ...(args.defaultLocale ? { defaultLocale: args.defaultLocale } : {}),
      tokenMinterPrivateKeyEnc: minter.privateKeyEnc,
      tokenMinterEoaAddress: minter.eoaAddress,
      staff: { create: { userId: args.ownerUserId, role: "OWNER" } },
      tiers: {
        create: {
          name: "Standard",
          minContribution: "100.00",
          maxContribution: "225.00",
          allocationAmount: "150.00",
          position: 0,
        },
      },
      ...(args.waiver
        ? {
            subscriptionWaivedAt: args.now,
            subscriptionWaiverReason: args.waiver.label,
            subscriptionWaiverCodeId: args.waiver.codeId,
            createdWithWaiverCodeId: args.waiver.codeId,
          }
        : {}),
    },
  });
}
