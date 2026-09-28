// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";

import { maskValue, type SensitiveKind } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { usePrivacyMode } from "./privacy-provider";

// Wrap any rendered personal / per-person money value:
//
//   <Sensitive kind="name">{member.firstName} {member.lastName}</Sensitive>
//   <Sensitive kind="amount">{card.balance?.toString() ?? "—"}</Sensitive>
//
// Off: renders children as-is (no wrapper element — a fragment). On: renders
// a fixed placeholder for the kind instead, so the real value never reaches
// the screen. `mask` overrides the placeholder for one call site (e.g. keep
// the currency suffix). Usable from server and client components alike.
export function Sensitive({
  kind = "text",
  mask,
  className,
  children,
}: {
  kind?: SensitiveKind;
  mask?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const on = usePrivacyMode();
  const t = useTranslations("privacyMode");
  if (!on) return <>{children}</>;
  return (
    <span
      className={cn("select-none text-muted-foreground", className)}
      title={t("masked")}
      aria-label={t("masked")}
    >
      {mask ?? maskValue(kind)}
    </span>
  );
}
