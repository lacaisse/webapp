// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

import type {
  ProposeActionResult,
  SignActionResult,
  SigningPasskeyHandle,
} from "@/services/safe/action-types";
import { signTransactionWithPasskeyAction } from "@/services/safe/passkey-actions";
import {
  assertSigningPasskey,
  ceremonyErrorMessage,
  isCeremonyCancelled,
} from "@/services/safe/passkey-client";
import type { Hex } from "@/services/safe/types";

// Client glue for signing with the member's passkey. `handle` is the current
// user's signing credential for this fund (null when they have none, or own
// the Safe with a legacy server key — then the plain sign action applies).

export type PasskeySignOutcome =
  | { kind: "signed"; executed: boolean; txHash: string | null }
  | { kind: "cancelled" }
  | { kind: "error"; error: string };

export function usePasskeySigning(handle: SigningPasskeyHandle | null) {
  const t = useTranslations("fund.safes.passkey");

  const sign = useCallback(
    async (a: { safeId: string; transactionId: string; safeTxHash: string }): Promise<PasskeySignOutcome> => {
      if (!handle) return { kind: "error", error: t("noHandle") };
      let response;
      try {
        response = await assertSigningPasskey(handle, a.safeTxHash as Hex);
      } catch (e) {
        if (isCeremonyCancelled(e)) return { kind: "cancelled" };
        return { kind: "error", error: ceremonyErrorMessage(e, t("ceremonyFailed")) };
      }
      const res: SignActionResult = await signTransactionWithPasskeyAction({
        safeId: a.safeId,
        transactionId: a.transactionId,
        response,
      });
      if ("error" in res) return { kind: "error", error: res.error };
      return { kind: "signed", executed: res.executed, txHash: res.txHash };
    },
    [handle, t],
  );

  return { sign, available: handle !== null };
}

// What a propose dialog shows once the proposal exists: executed right
// away, waiting for the others, or — a passkey proposer who dismissed the
// prompt — proposed but not yet signed by them.
export type ProposalOutcome = {
  transactionId: string;
  executed: boolean;
  txHash: string | null;
  // The proposer's own signature is still missing (ceremony cancelled /
  // failed); `error` carries why when it failed.
  unsigned: boolean;
  error: string | null;
};

/**
 * Finish a proposal: when the action says the proposer must sign with their
 * passkey, run the ceremony right away so one click proposes AND signs. A
 * dismissed prompt leaves a valid unsigned proposal the member can sign from
 * the pending list.
 */
export function useProposeAndSign(safeId: string, handle: SigningPasskeyHandle | null) {
  const passkey = usePasskeySigning(handle);

  const finish = useCallback(
    async (res: Extract<ProposeActionResult, { ok: true }>): Promise<ProposalOutcome> => {
      if (!res.awaitingSignature) {
        return {
          transactionId: res.transactionId,
          executed: res.executed,
          txHash: res.txHash,
          unsigned: false,
          error: null,
        };
      }
      const outcome = await passkey.sign({
        safeId,
        transactionId: res.transactionId,
        safeTxHash: res.safeTxHash,
      });
      if (outcome.kind === "signed") {
        return {
          transactionId: res.transactionId,
          executed: outcome.executed,
          txHash: outcome.txHash,
          unsigned: false,
          error: null,
        };
      }
      return {
        transactionId: res.transactionId,
        executed: false,
        txHash: null,
        unsigned: true,
        error: outcome.kind === "error" ? outcome.error : null,
      };
    },
    [passkey, safeId],
  );

  return { finish };
}
