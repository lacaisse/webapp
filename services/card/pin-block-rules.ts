// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  CardBlockedReason,
  CardStatus,
} from "@/services/db/generated/enums";

// Which side owns a card's status (D12, plan §6 "PR W-P"). Status is
// local-authoritative — the fund blocks and unblocks its cards and the sync
// pushes the local value to Citizen Pay on a mismatch — with one exception: a
// PIN block (`pin_blocked_at` on the api, three wrong PIN entries) belongs to
// the api. La Caisse imports it, never pushes ACTIVE over it, and pulls the
// card back when the api no longer reports it (the holder set a new PIN in
// the wallet, or the explicit unblock ran). A fund block stays the fund's
// even while the api reports a PIN block: the api lets the issuer's `PATCH
// {status:"blocked"}` supersede the PIN block, so a lost card the fund
// blocked while Citizen Pay was unreachable is pushed, not overwritten.
//
// Pure, so the webhook receiver, the card sync and the tests share one rule.

export type LocalCardState = {
  status: CardStatus;
  blockedReason: CardBlockedReason | null;
  blockedAt: Date | null;
};

export type RemoteCardState = {
  status: CardStatus;
  // The api's `pin_blocked_at`, ISO 8601; null (or missing on an api that
  // predates PR P, which the client reads as null) = not PIN-blocked.
  pinBlockedAt: string | null;
};

export type CardStateTransition =
  // The api reports a PIN block the local row does not carry: import it.
  | {
      kind: "pin_block";
      data: { status: "BLOCKED"; blockedReason: "PIN"; blockedAt: Date };
    }
  // The local row carries a PIN block the api no longer reports: pull the
  // api's status (ACTIVE after a wallet unblock; BLOCKED when the fund
  // blocked it from elsewhere, then as a fund block).
  | {
      kind: "pin_release";
      data: {
        status: CardStatus;
        blockedReason: CardBlockedReason | null;
        blockedAt: Date | null;
      };
    }
  // Local is authoritative and the two differ: push ours (today's rule).
  | { kind: "push" }
  | { kind: "none" };

export function isPinBlocked(local: {
  status: CardStatus;
  blockedReason: CardBlockedReason | null;
}): boolean {
  return local.status === "BLOCKED" && local.blockedReason === "PIN";
}

export function planCardStateSync(
  local: LocalCardState,
  remote: RemoteCardState,
  now: Date = new Date(),
  // `apiRefused`: the api answered the fund's push with its PIN-block 409
  // (the card's own block, or — for an enrolled fund — the issuer's). There
  // is nothing left to push: the api's block is imported even over a local
  // fund block.
  opts: { apiRefused?: boolean } = {},
): CardStateTransition {
  const localPin = isPinBlocked(local);

  if (remote.pinBlockedAt !== null) {
    // A fund block supersedes (see header): the api clears pin_blocked_at on
    // the issuer's PATCH blocked, so push the fund's block when it has not
    // landed yet. Rows blocked before `blockedReason` existed read as FUND.
    if (!opts.apiRefused && local.status === "BLOCKED" && !localPin) {
      return remote.status === "BLOCKED" ? { kind: "none" } : { kind: "push" };
    }
    const at = parseBlockedAt(remote.pinBlockedAt, now);
    if (localPin && local.blockedAt?.getTime() === at.getTime()) {
      return { kind: "none" };
    }
    return {
      kind: "pin_block",
      data: { status: "BLOCKED", blockedReason: "PIN", blockedAt: at },
    };
  }

  if (localPin) {
    const blocked = remote.status === "BLOCKED";
    return {
      kind: "pin_release",
      data: {
        status: remote.status,
        blockedReason: blocked ? "FUND" : null,
        blockedAt: blocked ? (local.blockedAt ?? now) : null,
      },
    };
  }

  return remote.status === local.status ? { kind: "none" } : { kind: "push" };
}

function parseBlockedAt(iso: string, fallback: Date): Date {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? fallback : new Date(ms);
}
