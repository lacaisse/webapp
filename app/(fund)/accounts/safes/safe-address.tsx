// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExternalLink } from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

import { shortAddress } from "./format";

// Address with a copy button and an external link (Safe{Wallet} for a Safe,
// the explorer for anything else). Hook-free: usable from server components.
export function SafeAddress({
  address,
  href,
  linkLabel,
  full,
  className,
}: {
  address: string;
  href?: string | null;
  linkLabel?: string;
  full?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      <span
        className={cn(
          "font-mono text-xs text-muted-foreground",
          full && "break-all",
        )}
        title={address}
      >
        {full ? address : shortAddress(address)}
      </span>
      <CopyButton value={address} />
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={linkLabel}
          title={linkLabel}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </span>
  );
}
