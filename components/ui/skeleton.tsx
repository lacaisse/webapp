// SPDX-License-Identifier: AGPL-3.0-or-later
import { cn } from "@/lib/utils";

// Pulsing placeholder block. Used for Suspense fallbacks / loading.tsx shells
// so a route paints an instant skeleton while its data streams in.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
