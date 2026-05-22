// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";

// Small icon button that writes `value` to the clipboard and flips to a
// check mark for ~1.5s. Used inline next to addresses, transaction hashes,
// API key IDs — anything an admin might want to copy out of the UI.
//
// Falls back silently if `navigator.clipboard` is unavailable (older
// browsers / insecure contexts). The label comes from i18n
// (`common.copy.label`) so screen readers + tooltips share one translation.

export function CopyButton({
  value,
  label,
}: {
  value: string;
  label?: string;
}) {
  const t = useTranslations("common.copy");
  const [copied, setCopied] = useState(false);

  const ariaLabel = label ?? t("label");

  async function handleClick() {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Permissions can deny clipboard access — ignore silently.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={handleClick}
      aria-label={copied ? t("copied") : ariaLabel}
      title={copied ? t("copied") : ariaLabel}
    >
      {copied ? (
        <Check className="text-emerald-600" />
      ) : (
        <Copy className="text-muted-foreground" />
      )}
    </Button>
  );
}
