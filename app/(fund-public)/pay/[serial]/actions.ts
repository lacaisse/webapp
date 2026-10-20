// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { StartCardTopUpSchema } from "@/services/card-topup/amount";
import {
  createPendingTopUp,
  findTopUpForCard,
  isTopUpReady,
  listTopUpBanks,
  loadTopUpCard,
} from "@/services/card-topup/data";
import {
  attachPaymentRequest,
  settleCardTopUp,
  type TopUpStatus,
} from "@/services/card-topup/settle";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { getFundUrl, requireCurrentFund } from "@/services/fund/server";

// Public (no auth) actions behind the open-banking card top-up — see
// ./page.tsx. Trust comes from the host-resolved fund, the card serial being
// in that fund, and CitizenPay's own record of the payment request (verified
// in services/card-topup/settle.ts before anything is minted).

export type StartCardTopUpResult =
  | { ok: true; url: string }
  | { error: string; field?: "amount" | "bank" | "iban" };

export async function startCardTopUpAction(
  input: z.input<typeof StartCardTopUpSchema>,
): Promise<StartCardTopUpResult> {
  const t = await getTranslations();
  const parsed = StartCardTopUpSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path[0];
    return {
      error: t(issue.message as never),
      field:
        path === "amountCents"
          ? "amount"
          : path === "bankId"
            ? "bank"
            : path === "iban"
              ? "iban"
              : undefined,
    };
  }
  const { serial, amountCents, bankId, iban } = parsed.data;

  const fund = await requireCurrentFund();
  const unavailable = { error: t("cotisation.topUp.errors.unavailable") };
  if (!isTopUpReady(fund) || !fund.citizenPayFundId) return unavailable;

  const card = await loadTopUpCard(fund.id, serial);
  if (!card?.account || card.status === "BLOCKED") return unavailable;

  // The bank must be one CP can initiate a payment at; some also need the
  // payer's IBAN before they show the signing page.
  const banks = await listTopUpBanks(fund);
  const bank = banks?.find((b) => b.id === bankId);
  if (!bank) {
    return { error: t("cotisation.topUp.errors.bankRequired"), field: "bank" };
  }
  if (bank.requiresDebtorIban && !iban) {
    return { error: t("cotisation.topUp.errors.ibanRequired"), field: "iban" };
  }

  try {
    const topUp = await createPendingTopUp({
      fundId: fund.id,
      cardId: card.id,
      memberId: card.memberId,
      account: card.account,
      amountCents,
    });
    // CP appends `paymentRequestId=<id>` to this on the way back from the bank.
    const redirectUri = `${getFundUrl(fund.domain)}/pay/${encodeURIComponent(
      card.serialNumber,
    )}/return?topup=${encodeURIComponent(topUp.id)}`;
    const url = getCitizenPayClient(fund).topUpSignUrl({
      treasuryId: fund.citizenPayFundId,
      bankId: bank.id,
      redirectUri,
      amountCents,
      accountAddress: card.account,
      iban: bank.requiresDebtorIban ? iban : undefined,
    });
    return { ok: true, url };
  } catch (e) {
    console.error("[card-topup] start failed", fund.id, e);
    return { error: t("cotisation.topUp.errors.startFailed") };
  }
}

const PollSchema = z.object({
  serial: z.string().trim().min(1).max(64),
  topUpId: z.string().trim().min(1).max(64),
  // From the bank redirect (CP appends it); only needed on the first poll.
  paymentRequestId: z.number().int().positive().optional(),
});

export type PollCardTopUpResult =
  | {
      status: TopUpStatus;
      amountCents: number;
      // CP / the mint couldn't be reached this time; the poller retries.
      checkFailed?: boolean;
    }
  | { status: "not_found" };

export async function pollCardTopUpAction(
  input: z.input<typeof PollSchema>,
): Promise<PollCardTopUpResult> {
  const parsed = PollSchema.safeParse(input);
  if (!parsed.success) return { status: "not_found" };
  const { serial, topUpId, paymentRequestId } = parsed.data;

  const fund = await requireCurrentFund();
  const row = await findTopUpForCard(fund.id, serial, topUpId);
  if (!row) return { status: "not_found" };
  const amountCents = row.amountCents;

  try {
    if (row.citizenPayPaymentRequestId == null) {
      if (paymentRequestId == null) return { status: "pending", amountCents };
      const attached = await attachPaymentRequest(fund, row.id, paymentRequestId);
      if (attached !== "attached" && attached !== "already") {
        return { status: "not_found" };
      }
    }
    const status = await settleCardTopUp(fund, row.id);
    return { status, amountCents };
  } catch (e) {
    console.error("[card-topup] poll failed", row.id, e);
    return {
      status: row.status.toLowerCase() as TopUpStatus,
      amountCents,
      checkFailed: true,
    };
  }
}
