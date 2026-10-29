// SPDX-License-Identifier: AGPL-3.0-or-later

// Error text that ends up on a FundSafe / FundSafeTransaction row (and so on
// the page and in logs) must not carry the platform RPC key: viem embeds the
// request URL, `https://<net>.g.alchemy.com/v2/<key>`, in its messages
// (review S13).
const RPC_KEY_IN_URL = /(\/v2\/)[A-Za-z0-9_-]{8,}/g;

export function redactRpcKey(message: string): string {
  return message.replace(RPC_KEY_IN_URL, "$1[redacted]");
}
