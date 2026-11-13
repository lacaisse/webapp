// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getCitizenPayClient, type FundCredentials } from "@/services/citizenpay/client";
import {
  SYNCED_COLUMN,
  isDefaultValue,
  type PaymentSettingField,
  type PaymentSettingValue,
} from "@/services/citizenpay/payment-settings-rules";
import type { ApplyPaymentSettingOutcome } from "@/services/citizenpay/sync-payment-settings";
import type { TreasuryPaymentSettings } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

import { eligibleFeeAccounts, type FeeAccountOption } from "./payment-settings-schema";

// Server-side pieces of the payment settings (Settings → Fees, Settings →
// Citizen Pay → Terminals): the fund's own accounts a fee account may be,
// what Citizen Pay applies right now, and recording an apply outcome on the
// fund row + FundPaymentSettingEvent. All fund-scoped by the caller's fund.

/**
 * The fund's eligible fee accounts (payment-settings-schema.ts::
 * eligibleFeeAccounts): its main (minter) account, its STANDARD token
 * accounts and its active, unarchived Safes on the token's chain — never a
 * SOURCE account, never a merchant's, never another fund's.
 */
export async function loadFeeAccountOptions(
  fund: {
    id: string;
    tokenMinterSmartAccountAddress: string | null;
    tokenChainId: number;
  },
  minterName: string,
): Promise<FeeAccountOption[]> {
  const [accounts, safes] = await Promise.all([
    prisma.fundTokenAccount.findMany({
      where: { fundId: fund.id, archivedAt: null, kind: "STANDARD" },
      orderBy: { createdAt: "asc" },
      select: { name: true, address: true, kind: true },
    }),
    prisma.fundSafe.findMany({
      where: {
        fundId: fund.id,
        archivedAt: null,
        status: "ACTIVE",
        chainId: fund.tokenChainId,
      },
      orderBy: { createdAt: "asc" },
      select: { name: true, address: true },
    }),
  ]);
  return eligibleFeeAccounts({
    minterAddress: fund.tokenMinterSmartAccountAddress,
    minterName,
    accounts,
    safes,
  });
}

/**
 * What Citizen Pay applies right now (`GET /v2/treasury`): null when the
 * fund is not connected, "error" when the read failed (the page says the
 * live value could not be read, and renders anyway). A field missing from the
 * answer = this api does not support it.
 */
export async function loadRemotePaymentSettings(
  fund: FundCredentials,
): Promise<TreasuryPaymentSettings | "error" | null> {
  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) return null;
  try {
    return await getCitizenPayClient(fund).getTreasuryPaymentSettings();
  } catch (e) {
    console.warn("[settings] payment settings read failed", fund.id, e);
    return "error";
  }
}

/**
 * Record what applying `wanted` on Citizen Pay came to, for a fund whose row
 * already holds `wanted` (pending). Writes are conditioned on the row still
 * holding `wanted`, so a save that landed meanwhile keeps its own state.
 *   applied       synced; if CP's value changed, an "applied" event names who
 *                 and when;
 *   notSupported  pending, unless `wanted` is the default (an api without
 *                 the setting applies exactly that: nothing to apply);
 *   refused       back to the value CP still applies, synced (the control
 *                 shows what is live; the refused value is not kept);
 *   failed        pending.
 */
export async function recordPaymentSettingOutcome(
  fundId: string,
  field: PaymentSettingField,
  wanted: PaymentSettingValue,
  outcome: ApplyPaymentSettingOutcome,
  userId: string,
): Promise<void> {
  const synced = SYNCED_COLUMN[field];
  const where = { id: fundId, [field]: wanted };
  switch (outcome.kind) {
    case "applied": {
      const res = await prisma.fund.updateMany({ where, data: { [synced]: true } });
      if (outcome.changed && res.count > 0) {
        await prisma.fundPaymentSettingEvent.create({
          data: { fundId, field, value: JSON.stringify(wanted), action: "applied", userId },
        });
      }
      return;
    }
    case "notSupported":
      await prisma.fund.updateMany({
        where,
        data: { [synced]: isDefaultValue(field, wanted) },
      });
      return;
    case "refused":
      await prisma.fund.updateMany({
        where,
        data: { [field]: outcome.confirmed, [synced]: true },
      });
      return;
    case "failed":
      await prisma.fund.updateMany({ where, data: { [synced]: false } });
      return;
  }
}

/**
 * Take Citizen Pay's current value over as La Caisse's own ("Use Citizen
 * Pay's value"): stored, synced, and recorded as "adopted".
 */
export async function adoptRemotePaymentSetting(
  fundId: string,
  field: PaymentSettingField,
  value: PaymentSettingValue,
  userId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.fund.update({
      where: { id: fundId },
      data: { [field]: value, [SYNCED_COLUMN[field]]: true },
    }),
    prisma.fundPaymentSettingEvent.create({
      data: { fundId, field, value: JSON.stringify(value), action: "adopted", userId },
    }),
  ]);
}

/** The fund row's value of a setting. */
export function localPaymentSetting(
  fund: {
    feeAccountAddress: string | null;
    platformPayoutFeeBps: number;
    earlyPaidMaxCents: number | null;
  },
  field: PaymentSettingField,
): PaymentSettingValue {
  return fund[field];
}
