// SPDX-License-Identifier: AGPL-3.0-or-later
import { requireCurrentFund } from "@/services/fund/server";

import { CotisationPaymentPage } from "./cotisation-page";
import { TopUpPage } from "./top-up-page";

// Public, no-auth per-card payment page (see AGENTS.md "(fund-public)"),
// reached from the cotisation reminder email and from the card wallet's
// "Add funds" button (the treasury top-up URL, `https://<fund>/pay/<serial>`).
//
//   - PAY_AND_GO: open-banking top-up — the member picks an amount and their
//     bank, signs the payment at the bank, and the same amount is minted to
//     the card (./top-up-page.tsx, ./actions.ts, ./return/).
//   - FIXED_PERIOD / DISABLED: the monthly cotisation by bank transfer —
//     IBAN + reference + EPC QR (./cotisation-page.tsx), unchanged.

export default async function PayPage({
  params,
}: {
  params: Promise<{ serial: string }>;
}) {
  const fund = await requireCurrentFund();
  const { serial } = await params;

  if (fund.allocationMode === "PAY_AND_GO") {
    return <TopUpPage fund={fund} serial={serial} />;
  }
  return <CotisationPaymentPage fund={fund} serial={serial} />;
}
