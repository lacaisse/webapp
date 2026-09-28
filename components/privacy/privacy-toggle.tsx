// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { setPrivacyMode } from "@/services/privacy/actions";

// Sidebar switch for privacy mode. The action sets/clears the cookie and
// revalidates the layout, so every server-rendered mask follows on refresh.
export function PrivacyToggle({ enabled }: { enabled: boolean }) {
  const t = useTranslations("privacyMode");
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      aria-pressed={enabled}
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await setPrivacyMode(!enabled);
        });
      }}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors disabled:opacity-60",
        enabled
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
      )}
    >
      {enabled ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      {t("toggle")}
    </button>
  );
}
