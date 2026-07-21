// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Store,
  User,
  Wallet2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { isZeroAddress, shortAddress } from "@/services/alchemy/format";

// Friendly rendering for an on-chain address. Resolves cards (which we
// own locally), special protocol addresses (zero = mint/burn, fund
// minter), and falls back to a truncated hex with an "Unknown" badge so
// non-crypto users get something they can recognise.

export type AddressDirectory = {
  // lowercased address -> labels
  cards: Map<string, { name: string }>;
  places: Map<string, { name: string }>;
  accounts: Map<string, { name: string }>;
  profiles: Map<string, { name: string; imageSmall: string | null }>;
  minterAddresses: Set<string>;
};

export function buildAddressDirectory(opts: {
  cards: Array<{
    account: string | null;
    holderName: string | null;
    memberName: string;
    serialNumber: string;
  }>;
  places: Array<{ account: string | null; name: string }>;
  // Named fund token accounts (services/token-account) — Safe wallets the
  // fund controls. Resolves their addresses to the operator-given name.
  // Optional: views that don't load them simply skip account resolution.
  accounts?: Array<{ account: string | null; name: string }>;
  profiles: Array<{ account: string; name: string; imageSmall: string | null }>;
  minterEoa: string | null;
  minterSmartAccount: string | null;
}): AddressDirectory {
  const cards = new Map<string, { name: string }>();
  for (const c of opts.cards) {
    if (!c.account) continue;
    cards.set(c.account.toLowerCase(), {
      name: c.holderName?.trim() || c.memberName || c.serialNumber,
    });
  }
  const places = new Map<string, { name: string }>();
  for (const p of opts.places) {
    if (!p.account) continue;
    places.set(p.account.toLowerCase(), { name: p.name });
  }
  const accounts = new Map<string, { name: string }>();
  for (const a of opts.accounts ?? []) {
    if (!a.account) continue;
    accounts.set(a.account.toLowerCase(), { name: a.name });
  }
  const profiles = new Map<string, { name: string; imageSmall: string | null }>();
  for (const p of opts.profiles) {
    if (!p.account) continue;
    profiles.set(p.account.toLowerCase(), {
      name: p.name,
      imageSmall: p.imageSmall,
    });
  }
  const minterAddresses = new Set<string>();
  if (opts.minterEoa) minterAddresses.add(opts.minterEoa.toLowerCase());
  if (opts.minterSmartAccount)
    minterAddresses.add(opts.minterSmartAccount.toLowerCase());
  return { cards, places, accounts, profiles, minterAddresses };
}

/**
 * Wraps an `AddressLabel` in a link to that account's audit page
 * (/token/account/[address]) so every address in the explorer is a
 * drill-down entry point. The zero address has no account to audit —
 * it renders unwrapped.
 */
export function AddressLink({
  address,
  children,
}: {
  address: string;
  children: React.ReactNode;
}) {
  if (isZeroAddress(address)) return <>{children}</>;
  return (
    <Link
      href={`/token/account/${address.toLowerCase()}`}
      className="inline-flex rounded-sm underline-offset-4 decoration-dotted hover:underline focus-visible:underline"
    >
      {children}
    </Link>
  );
}

export function AddressLabel({
  address,
  directory,
  side,
  labels,
}: {
  address: string;
  directory: AddressDirectory;
  /** Whether this address is the sender or receiver in the row. Lets us
   *  render the zero address as "Issued" (mint) or "Retired" (burn). */
  side: "from" | "to";
  labels: {
    issued: string;
    retired: string;
    treasury: string;
    unknown: string;
  };
}) {
  const lower = address.toLowerCase();

  if (isZeroAddress(lower)) {
    const label = side === "from" ? labels.issued : labels.retired;
    const Icon = side === "from" ? ArrowDownToLine : ArrowUpFromLine;
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{label}</span>
      </span>
    );
  }

  // Named fund accounts win over the generic "Treasury" label — the minter's
  // own Safe (salt 0) is the "Main account", so it shows that name rather than
  // "Treasury". The bare minter EOA (not an account) still falls through to the
  // treasury label below.
  const account = directory.accounts.get(lower);
  if (account) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Wallet2 className="size-3.5 text-muted-foreground" />
        <span>{account.name}</span>
      </span>
    );
  }

  if (directory.minterAddresses.has(lower)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <ArrowDownToLine className="size-3.5 text-primary" />
        <span className="font-medium">{labels.treasury}</span>
      </span>
    );
  }

  const card = directory.cards.get(lower);
  if (card) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <User className="size-3.5 text-muted-foreground" />
        <span>{card.name}</span>
      </span>
    );
  }

  const place = directory.places.get(lower);
  if (place) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Store className="size-3.5 text-muted-foreground" />
        <span>{place.name}</span>
      </span>
    );
  }

  const profile = directory.profiles.get(lower);
  if (profile) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        {profile.imageSmall ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.imageSmall}
            alt=""
            className="size-3.5 rounded-full object-cover"
          />
        ) : (
          <User className="size-3.5 text-muted-foreground" />
        )}
        <span>{profile.name}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Store className="size-3.5 text-muted-foreground" />
      <span className="font-mono text-xs text-muted-foreground">
        {shortAddress(lower)}
      </span>
      <Badge variant="outline">{labels.unknown}</Badge>
    </span>
  );
}
