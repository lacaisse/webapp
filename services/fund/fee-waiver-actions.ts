// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";

import {
  businessBelongsToFund,
  feeWaiverClient,
  isNotFound,
} from "./fee-waivers";

// Settings → Fees, "Businesses exempt from the fixed fee": add / remove a
// waiver on Citizen Pay. ADMIN-only like the rest of settings. The business id
// comes from the browser, so it is checked against THIS fund before anything
// is sent: adding needs one of the fund's own merchants in that business;
// removing accepts that too, or a business the treasury's own waiver list
// (read with the fund's key) holds — so a waiver whose merchants were since
// removed locally can still be lifted.

export type FeeWaiverActionResult = { ok: true } | { error: string };

const BusinessIdSchema = z.object({
  businessId: z.string().trim().min(1).max(200),
});

export async function addFeeWaiverAction(
  input: z.input<typeof BusinessIdSchema>,
): Promise<FeeWaiverActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = BusinessIdSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("fund.settings.fees.waivers.errors.notFound") };
  }
  const { businessId } = parsed.data;
  if (!(await businessBelongsToFund(fund.id, businessId))) {
    return { error: t("fund.settings.fees.waivers.errors.notFound") };
  }
  const client = feeWaiverClient(fund);
  if (!client) return { error: t("fund.settings.fees.waivers.errors.notConnected") };
  try {
    await client.addFeeWaiver(businessId);
  } catch (e) {
    // The add control only shows once the list loaded, so the route exists:
    // a 404 here is CP saying the business has no place accepting the
    // fund's token (any more), or doesn't exist.
    if (isNotFound(e)) {
      return { error: t("fund.settings.fees.waivers.errors.notAccepting") };
    }
    console.error("[settings] fee waiver add failed", fund.id, businessId, e);
    return { error: t("fund.settings.fees.waivers.errors.failed") };
  }
  revalidatePath("/settings");
  return { ok: true };
}

export async function removeFeeWaiverAction(
  input: z.input<typeof BusinessIdSchema>,
): Promise<FeeWaiverActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = BusinessIdSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("fund.settings.fees.waivers.errors.notFound") };
  }
  const { businessId } = parsed.data;
  const client = feeWaiverClient(fund);
  if (!client) return { error: t("fund.settings.fees.waivers.errors.notConnected") };
  try {
    const ours =
      (await businessBelongsToFund(fund.id, businessId)) ||
      (await client.listFeeWaivers()).some((w) => w.businessId === businessId);
    if (!ours) return { error: t("fund.settings.fees.waivers.errors.notFound") };
    await client.removeFeeWaiver(businessId);
  } catch (e) {
    if (isNotFound(e)) return { error: t("fund.settings.fees.waivers.errors.unavailable") };
    console.error("[settings] fee waiver remove failed", fund.id, businessId, e);
    return { error: t("fund.settings.fees.waivers.errors.failed") };
  }
  revalidatePath("/settings");
  return { ok: true };
}
