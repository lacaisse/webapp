// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { explorerTxUrl } from "@/services/safe/config";

// Success state shared by the propose dialogs: either the proposal already
// met the threshold and the relayer executed it (tx hash), or it now waits
// for the other owners.
export function ProposalResult({
  chainId,
  executed,
  txHash,
  threshold,
  unsigned,
  error,
}: {
  chainId: number;
  executed: boolean;
  txHash: string | null;
  threshold: number;
  // A passkey proposer who did not complete the signing ceremony: the
  // proposal exists, their own signature is still missing.
  unsigned?: boolean;
  error?: string | null;
}) {
  const t = useTranslations("fund.safes.proposal");
  if (unsigned) {
    return (
      <Alert variant="warning">
        <AlertTriangle className="size-4" />
        <AlertDescription>
          <div>{t("proposedUnsigned")}</div>
          {error && <div className="mt-1 text-xs">{error}</div>}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert>
      {executed ? <CheckCircle2 className="size-4" /> : <Clock className="size-4" />}
      <AlertDescription>
        <div>{executed ? t("executed") : t("proposed", { threshold })}</div>
        {txHash && (
          <a
            href={explorerTxUrl(chainId, txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block font-mono text-xs break-all"
          >
            {txHash}
          </a>
        )}
      </AlertDescription>
    </Alert>
  );
}
