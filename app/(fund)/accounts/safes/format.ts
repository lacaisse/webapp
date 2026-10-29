// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SafeTxSummary } from "@/services/safe/types";

// Pure display helpers for the Safes pages — shared by server components and
// the client dialogs/cards, so nothing here may touch the DB, env or chain.
// `t` is always a translator scoped to the `fund.safes` namespace
// (`getTranslations("fund.safes")` / `useTranslations("fund.safes")`).

export type SafesT = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** "0x1234…abcd" — keeps the checksum casing of the input. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Before deployment a Safe's address column holds a `pending:<saltNonce>`
 * placeholder — anything not starting with 0x is "not deployed yet": no copy
 * button, no Safe{Wallet} / explorer link.
 */
export function isDeployedAddress(address: string | null | undefined): address is string {
  return Boolean(address && address.startsWith("0x"));
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/** "2 of 3" (localised). */
export function thresholdLabel(n: number, m: number, t: SafesT): string {
  return t("thresholdOf", { n, m });
}

/** Clamp a threshold into 1..max (max ≥ 1). */
export function clampThreshold(value: number, max: number): number {
  const hi = Math.max(1, max);
  if (!Number.isFinite(value)) return 1;
  return Math.min(hi, Math.max(1, Math.round(value)));
}

const KINDS = new Set([
  "TOKEN_TRANSFER",
  "ADD_OWNER",
  "REMOVE_OWNER",
  "SWAP_OWNER",
  "CHANGE_THRESHOLD",
  "REJECTION",
]);

/** Narrow the Prisma `Json` summary column; null when it isn't one. */
export function parseSummary(value: unknown): SafeTxSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  return value as SafeTxSummary;
}

// Label for an address in a summary: the label frozen at proposal time, else
// a name we know now (owners, accounts), else the short address.
function who(
  address: string,
  label: string | null | undefined,
  names: Record<string, string> | undefined,
): string {
  const frozen = label?.trim();
  if (frozen) return frozen;
  return names?.[address.toLowerCase()] ?? shortAddress(address);
}

/**
 * One human line for a Safe transaction, from its stored summary — never from
 * calldata. `names` maps lowercased address → display name as a fallback for
 * summaries recorded without a label. Falls back to the generic kind label
 * when the summary is missing (`kind` from the row).
 */
export function summaryLine(
  summary: SafeTxSummary | null,
  t: SafesT,
  tokenSymbol: string | null,
  opts: { names?: Record<string, string>; kind?: string } = {},
): string {
  const { names } = opts;
  if (!summary) return t(`tx.kinds.${opts.kind ?? "UNKNOWN"}`);
  switch (summary.kind) {
    case "TOKEN_TRANSFER":
      return t("tx.summary.transfer", {
        amount: tokenSymbol ? `${summary.amount} ${tokenSymbol}` : summary.amount,
        recipient: who(summary.recipient, summary.recipientLabel, names),
      });
    case "ADD_OWNER":
      return t("tx.summary.addOwner", {
        owner: who(summary.owner, summary.ownerLabel, names),
        threshold: summary.threshold,
      });
    case "REMOVE_OWNER":
      return t("tx.summary.removeOwner", {
        owner: who(summary.owner, summary.ownerLabel, names),
        threshold: summary.threshold,
      });
    case "SWAP_OWNER":
      return t("tx.summary.swapOwner", {
        oldOwner: who(summary.oldOwner, summary.oldOwnerLabel, names),
        newOwner: who(summary.newOwner, summary.newOwnerLabel, names),
      });
    case "CHANGE_THRESHOLD":
      return t("tx.summary.changeThreshold", { threshold: summary.threshold });
    case "REJECTION":
      return t("tx.summary.rejection", { nonce: summary.rejectsNonce });
  }
}

const LOW_GAS_WEI = BigInt("50000000000000000"); // 0.05 xDAI

export function isLowGas(balanceWei: string | null): boolean {
  if (balanceWei == null) return false;
  try {
    return BigInt(balanceWei) < LOW_GAS_WEI;
  } catch {
    return false;
  }
}

/** Wei → "0.0123" (4 decimals, truncated). */
export function formatNative(balanceWei: string): string {
  let wei: bigint;
  try {
    wei = BigInt(balanceWei);
  } catch {
    return "—";
  }
  const unit = BigInt("1000000000000000000");
  const whole = wei / unit;
  const frac = (wei % unit).toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

/** Initials for an avatar fallback ("Kevin Durant" → "KD"). */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + second).toUpperCase();
}
