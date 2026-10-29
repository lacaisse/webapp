// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ArrowLeftRight,
  Ban,
  Send,
  SlidersHorizontal,
  UserMinus,
  UserPlus,
} from "lucide-react";

import type { FundSafeTxKind } from "@/services/db/generated/enums";
import { cn } from "@/lib/utils";

const ICONS: Record<FundSafeTxKind, React.ComponentType<{ className?: string }>> = {
  TOKEN_TRANSFER: Send,
  ADD_OWNER: UserPlus,
  REMOVE_OWNER: UserMinus,
  SWAP_OWNER: ArrowLeftRight,
  CHANGE_THRESHOLD: SlidersHorizontal,
  REJECTION: Ban,
};

// Round glyph for a Safe transaction kind. Hook-free (server + client).
export function TxKindIcon({
  kind,
  className,
}: {
  kind: FundSafeTxKind;
  className?: string;
}) {
  const Icon = ICONS[kind] ?? Send;
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
        kind === "REJECTION" && "bg-destructive/10 text-destructive",
        className,
      )}
      aria-hidden
    >
      <Icon className="size-4" />
    </span>
  );
}
