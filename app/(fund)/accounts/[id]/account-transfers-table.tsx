// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { getAccountTransfersAction } from "@/services/token-account/admin-actions";
import type { AccountTransfer } from "@/services/token-account/transfers";

import { TransfersTable } from "./transfers-table";

// The named-account page's history: TransfersTable paged by
// getAccountTransfersAction.
export function AccountTransfersTable({
  id,
  ...props
}: {
  id: string;
  initial: AccountTransfer[];
  initialCursor: string | null;
  symbol: string | null;
  accountNames: Record<string, string>;
}) {
  return (
    <TransfersTable
      {...props}
      loadMore={(cursor) => getAccountTransfersAction({ id, cursor })}
    />
  );
}
