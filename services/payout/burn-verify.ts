// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { formatUnits } from "viem";

import {
  getTxReceiptWithLogs,
  getUserOpTx,
  TRANSFER_TOPIC,
  type TxReceiptWithLogs,
} from "@/services/token/userop";

// Check that a hash an admin pastes really is THIS payout's burn before we
// report it to CP. Reporting marks the payout burnt, sweeps the fees and
// unlocks the bank payment, so a typo or another payout's hash must not get
// through. A burn of the place's tokens is an ERC20 `Transfer` from the
// place's account to the zero address, emitted by the fund's token, for
// exactly the payout `net` (in token units).

export type BurnCheck =
  | { ok: true; txHash: string }
  | { reason: "notFound" }
  | { reason: "notSuccessful" }
  | { reason: "notBurn" }
  | { reason: "wrongAmount"; found: string; expected: string };

const ZERO_TOPIC = `0x${"0".repeat(64)}`;

function addressTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.toLowerCase().replace(/^0x/, "")}`;
}

export type ResolvedReceipt =
  | { kind: "receipt"; receipt: TxReceiptWithLogs }
  | { kind: "notFound" }
  | { kind: "notSuccessful" };

/**
 * Resolve `hash` — a tx hash or a userOp hash — to its receipt with logs.
 * `notSuccessful` = a userOp the bundler reports reverted / timed out (it
 * moved nothing); `notFound` = neither the chain nor the bundler knows it
 * (yet). Throws only when the chain can't be read. Also used by the payout
 * backing check (operations.ts::checkPayoutBacking) to read the Transfer logs
 * of an order's settlement hash.
 */
export async function resolveReceiptWithLogs(
  chainId: number,
  hash: string,
): Promise<ResolvedReceipt> {
  const receipt = await getTxReceiptWithLogs({ chainId, txHash: hash });
  if (receipt) return { kind: "receipt", receipt };

  // Not a known tx hash: it may be a userOp hash (what the burn pipeline
  // logs). The bundler resolves those to their settlement tx.
  const userOp = await getUserOpTx(chainId, hash);
  if (userOp.status === "reverted" || userOp.status === "timeout") {
    return { kind: "notSuccessful" };
  }
  if (userOp.status !== "success" || !userOp.txHash) return { kind: "notFound" };
  const settled = await getTxReceiptWithLogs({ chainId, txHash: userOp.txHash });
  return settled ? { kind: "receipt", receipt: settled } : { kind: "notFound" };
}

/**
 * Resolve `hash` — a tx hash or a userOp hash — to a receipt and check it is
 * a burn of `amount` units of `token` from `from`. Throws only when the chain
 * can't be read (the caller says "try again", never "not found").
 */
export async function verifyPayoutBurn(args: {
  chainId: number;
  hash: string;
  token: string;
  from: string;
  amount: bigint;
  decimals: number;
}): Promise<BurnCheck> {
  const resolved = await resolveReceiptWithLogs(args.chainId, args.hash);
  if (resolved.kind !== "receipt") return { reason: resolved.kind };
  const { receipt } = resolved;

  if (receipt.status !== "success") return { reason: "notSuccessful" };

  const token = args.token.toLowerCase();
  const fromTopic = addressTopic(args.from);
  const burns = receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === token &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      l.topics[1]?.toLowerCase() === fromTopic &&
      l.topics[2]?.toLowerCase() === ZERO_TOPIC,
  );
  if (burns.length === 0) return { reason: "notBurn" };

  let found = BigInt(0);
  for (const l of burns) {
    try {
      found += BigInt(l.data);
    } catch {
      return { reason: "notBurn" };
    }
  }
  if (found !== args.amount) {
    return {
      reason: "wrongAmount",
      found: formatUnits(found, args.decimals),
      expected: formatUnits(args.amount, args.decimals),
    };
  }
  return { ok: true, txHash: receipt.transactionHash };
}
