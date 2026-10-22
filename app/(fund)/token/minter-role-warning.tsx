// SPDX-License-Identifier: AGPL-3.0-or-later
import { AlertTriangle } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { checkMinterRole } from "@/services/token/permissions";

// Shown on /token when the fund's MINTER_ROLE was never verified on chain
// (Fund.tokenMintEnabledAt is null) and the minter Safe does not hold it:
// the same read, and the same message, as the pre-submit refusal in
// services/token/userop.ts → services/token-operations/direct.ts, so the
// operator learns before clicking "Mint" why it will be refused. Renders
// nothing once the role is verified, held, or when the read is inconclusive.
export async function MinterRoleWarning({
  fund,
}: {
  fund: {
    tokenAddress: string | null;
    tokenChainId: number;
    tokenMinterSmartAccountAddress: string | null;
    tokenMintEnabledAt: Date | null;
  };
}) {
  if (
    fund.tokenMintEnabledAt ||
    !fund.tokenAddress ||
    !fund.tokenMinterSmartAccountAddress
  ) {
    return null;
  }
  const status = await checkMinterRole({
    tokenAddress: fund.tokenAddress,
    chainId: fund.tokenChainId,
    account: fund.tokenMinterSmartAccountAddress,
  });
  if (status !== "missing-role") return null;

  const t = await getTranslations();
  return (
    <Alert variant="destructive">
      <AlertTriangle className="size-4" />
      <AlertDescription className="break-all">
        {t("tokenOps.errors.minterRoleMissing", {
          safe: fund.tokenMinterSmartAccountAddress,
          token: fund.tokenAddress,
        })}
      </AlertDescription>
    </Alert>
  );
}
