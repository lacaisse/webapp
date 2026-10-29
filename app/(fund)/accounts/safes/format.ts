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

// Label for an address in a summary. The address itself is never hidden: a
// label (frozen at proposal time, else a name we know now — owners, accounts)
// is shown next to the short address, "Alice (0x1234…abcd)", so a co-signer
// can't be shown a friendly name for an address they never saw.
function who(
  address: string,
  label: string | null | undefined,
  names: Record<string, string> | undefined,
): string {
  const short = shortAddress(address);
  const name = label?.trim() || names?.[address.toLowerCase()]?.trim();
  return name ? `${name} (${short})` : short;
}

// `previousThreshold` / `contract` were added to the stored summary later:
// rows written before carry neither, and a JSON column can hold anything, so
// both are checked at runtime rather than trusted from the type.
function previousThresholdOf(
  summary: Extract<SafeTxSummary, { kind: "ADD_OWNER" | "REMOVE_OWNER" | "CHANGE_THRESHOLD" }>,
): number | undefined {
  const v: unknown = summary.previousThreshold;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The ERC-20 contract a TOKEN_TRANSFER calls: an address, `null` for native
 * xDAI, `undefined` when the summary predates the field.
 */
export function transferContract(summary: SafeTxSummary): string | null | undefined {
  if (summary.kind !== "TOKEN_TRANSFER") return undefined;
  const v: unknown = summary.contract;
  if (v === null) return null;
  return typeof v === "string" && v.startsWith("0x") ? v : undefined;
}

export type ThresholdChange = {
  kind: "ADD_OWNER" | "REMOVE_OWNER" | "CHANGE_THRESHOLD";
  from: number | undefined; // undefined on rows recorded before the field
  to: number;
};

/** The threshold an owner / threshold change sets, with the old one if known. */
export function thresholdChange(summary: SafeTxSummary | null): ThresholdChange | null {
  if (!summary) return null;
  switch (summary.kind) {
    case "ADD_OWNER":
    case "REMOVE_OWNER":
    case "CHANGE_THRESHOLD":
      return { kind: summary.kind, from: previousThresholdOf(summary), to: summary.threshold };
    default:
      return null;
  }
}

/**
 * The change lowers the bar: fewer signatures than before, or a single
 * signature where a new or remaining owner can act alone. Removing an owner
 * from a Safe that already needed 1 signature changes nothing.
 */
export function weakensSafe(change: ThresholdChange | null): boolean {
  if (!change) return false;
  if (change.from != null && change.to < change.from) return true;
  return change.to <= 1 && change.kind !== "REMOVE_OWNER";
}

/** "2 → 1" when the old threshold is known and differs, else "2". */
export function thresholdDeltaLabel(change: ThresholdChange): string {
  return change.from != null && change.from !== change.to
    ? `${change.from} → ${change.to}`
    : String(change.to);
}

/**
 * One human line for a Safe transaction, from its stored summary — never from
 * calldata. `names` maps lowercased address → display name as a fallback for
 * summaries recorded without a label. Falls back to the generic kind label
 * when the summary is missing (`kind` from the row). `tokenSymbol` is the
 * fund token's symbol, used for transfers whose summary has no `symbol`.
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
    case "TOKEN_TRANSFER": {
      // The symbol frozen on the summary (xDAI / EURe / fund token); rows
      // written before multi-token transfers carry none and moved the fund
      // token, so the caller's fund symbol applies.
      const symbol = summary.symbol?.trim() || tokenSymbol;
      return t("tx.summary.transfer", {
        amount: symbol ? `${summary.amount} ${symbol}` : summary.amount,
        recipient: who(summary.recipient, summary.recipientLabel, names),
      });
    }
    case "ADD_OWNER":
    case "REMOVE_OWNER": {
      const owner = who(summary.owner, summary.ownerLabel, names);
      const from = previousThresholdOf(summary);
      const base = summary.kind === "ADD_OWNER" ? "addOwner" : "removeOwner";
      if (from != null && from !== summary.threshold) {
        return t(`tx.summary.${base}ThresholdChange`, {
          owner,
          from,
          to: summary.threshold,
        });
      }
      return t(`tx.summary.${base}`, { owner, threshold: summary.threshold });
    }
    case "SWAP_OWNER":
      return t("tx.summary.swapOwner", {
        oldOwner: who(summary.oldOwner, summary.oldOwnerLabel, names),
        newOwner: who(summary.newOwner, summary.newOwnerLabel, names),
      });
    case "CHANGE_THRESHOLD": {
      const from = previousThresholdOf(summary);
      if (from != null && from !== summary.threshold) {
        return t("tx.summary.changeThresholdFromTo", { from, to: summary.threshold });
      }
      return t("tx.summary.changeThreshold", { threshold: summary.threshold });
    }
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

/**
 * Whether La Caisse alone holds enough owner keys to meet the threshold
 * (review S3): true when `threshold <= memberOwners`. Every MEMBER owner's
 * key sits with the server, so such a Safe is not an independent multisig
 * against the server; the dialogs say so.
 */
export function serverCanSignAlone(threshold: number, memberOwners: number): boolean {
  return memberOwners > 0 && threshold <= memberOwners;
}
