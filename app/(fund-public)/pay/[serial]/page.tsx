// SPDX-License-Identifier: AGPL-3.0-or-later
import { isTopUpReady } from "@/services/card-topup/data";
import { requireCurrentFund } from "@/services/fund/server";

import { CotisationPaymentPage } from "./cotisation-page";
import { TopUpPage } from "./top-up-page";

// Public, no-auth per-card payment page (see AGENTS.md "(fund-public)"),
// reached from the cotisation reminder email and, for FIXED_PERIOD funds, from
// the card wallet's "Add funds" button (the treasury top-up URL,
// `https://<fund>/pay/<serial>`). PAY_AND_GO funds' wallet button opens
// Citizen Pay's checkout instead (CP's default `top_up_url`); the open-banking
// top-up below still serves anyone who lands here.
//
//   - PAY_AND_GO: open-banking top-up — the member picks an amount and their
//     bank, signs the payment at the bank, and the same amount is minted to
//     the card (./top-up-page.tsx, ./actions.ts, ./return/).
//   - FIXED_PERIOD / DISABLED: the monthly cotisation by bank transfer —
//     IBAN + reference + EPC QR (./cotisation-page.tsx), unchanged.
//   - A PAY_AND_GO fund that can't take an open-banking top-up yet (not
//     connected to a CP treasury, or no minter / 4337 stack) falls back to
//     the transfer page too, so the reminder email's link still gets it paid
//     (the deposit is matched by serial and tier-minted as before).

export default async function PayPage({
  params,
}: {
  params: Promise<{ serial: string }>;
}) {
  const fund = await requireCurrentFund();
  const { serial } = await params;

  if (fund.allocationMode === "PAY_AND_GO" && isTopUpReady(fund)) {
    return <TopUpPage fund={fund} serial={serial} />;
  }
  return <CotisationPaymentPage fund={fund} serial={serial} />;
}
