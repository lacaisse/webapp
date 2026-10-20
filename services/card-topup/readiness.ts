// SPDX-License-Identifier: AGPL-3.0-or-later

// Can this fund mint at all? Mirrors what services/token/userop.ts's
// loadFundContext requires, so a misconfigured fund is caught before a
// top-up claims its mint (no FAILED TokenOperation per poll) and the top-up
// waits, SIGNED, for the sweep once the fund is fixed. Pure.
export function fundCanMint(fund: {
  tokenAddress: string | null;
  tokenDecimals: number | null;
  tokenMinterPrivateKeyEnc: string | null;
  tokenMinterEoaAddress: string | null;
  tokenMinterSmartAccountAddress: string | null;
  citizenPayEntrypointAddress: string | null;
  citizenPayAccountFactoryAddress: string | null;
  citizenPayPaymasterAddress: string | null;
  citizenPayPaymasterType: string | null;
}): boolean {
  return (
    !!fund.tokenAddress &&
    fund.tokenDecimals != null &&
    !!fund.tokenMinterPrivateKeyEnc &&
    !!fund.tokenMinterEoaAddress &&
    !!fund.tokenMinterSmartAccountAddress &&
    !!fund.citizenPayEntrypointAddress &&
    !!fund.citizenPayAccountFactoryAddress &&
    !!fund.citizenPayPaymasterAddress &&
    !!fund.citizenPayPaymasterType
  );
}
