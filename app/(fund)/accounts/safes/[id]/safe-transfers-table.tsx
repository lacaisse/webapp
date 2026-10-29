// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { getSafeTransfersAction } from "@/services/safe/admin-actions";
import type { SafeTransfer } from "@/services/safe/transfers";

import { TransfersTable } from "../../[id]/transfers-table";

// The Safe page's on-chain history (Transactions tab): the accounts
// TransfersTable, paged by getSafeTransfersAction. Rows carry their own
// symbol (fund token, xDAI, EURe).
export function SafeTransfersTable({
  safeId,
  ...props
}: {
  safeId: string;
  initial: SafeTransfer[];
  initialCursor: string | null;
  symbol: string | null;
  accountNames: Record<string, string>;
}) {
  return (
    <TransfersTable
      {...props}
      loadMore={(cursor) => getSafeTransfersAction({ safeId, cursor })}
    />
  );
}
