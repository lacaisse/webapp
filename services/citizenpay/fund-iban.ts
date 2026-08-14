// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getCitizenPayClient, type FundCredentials } from "./client";

// The fund's connected bank account IBAN (issue #86), same source as the
// public payment page (app/(fund-public)/pay/[serial]). Degrades to "" — same
// as an unconnected fund would show on that page — rather than failing the
// caller over a CitizenPay hiccup. Shared by the real card-assigned send
// (services/card/notify.ts) and the template editor's test send
// (services/email/template-actions.ts) so both resolve the same live value.
export async function resolveFundIban(fund: FundCredentials): Promise<string> {
  try {
    const status = await getCitizenPayClient(fund).getBankingStatus();
    return status.accountReference ?? "";
  } catch (e) {
    console.warn("[citizenpay] getBankingStatus failed", fund.id, e);
    return "";
  }
}
