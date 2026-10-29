// SPDX-License-Identifier: AGPL-3.0-or-later
import { Wallet } from "lucide-react";

import { Sensitive } from "@/components/privacy/sensitive";
import { cn } from "@/lib/utils";

import { initials } from "./format";

// Round avatar: the member's picture, else their initials; external owners
// get a wallet glyph. Hook-free so server and client components can use it.
export function OwnerAvatar({
  name,
  image,
  external,
  className,
}: {
  name: string;
  image?: string | null;
  external?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      {external ? <Wallet className="size-4" /> : initials(name)}
      {!external && image ? (
        <Sensitive kind="name" mask="">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image}
            alt=""
            className="absolute inset-0 size-full object-cover"
          />
        </Sensitive>
      ) : null}
    </span>
  );
}
