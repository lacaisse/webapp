// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";

// Renders the real widget in an iframe, at the same height the copied snippet
// uses, so what the admin previews is what a visitor will get. Same-origin
// framing is always permitted by the `/embed/*` CSP (`'self'` in proxy.ts),
// so the preview works before any external domain is configured.
//
// The iframe only mounts while open — each widget hits live chain/DB reads,
// so a collapsed preview must cost nothing.
export function EmbedPreview({
  src,
  height,
  title,
}: {
  src: string;
  height: number;
  title: string;
}) {
  const t = useTranslations("fund.settings.embeds.preview");
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-1">
      <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
        {open ? t("hide") : t("show")}
      </Button>
      {open ? (
        <div className="overflow-hidden rounded-md border bg-background">
          <iframe
            src={src}
            title={title}
            width="100%"
            height={height}
            style={{ border: 0, display: "block" }}
          />
        </div>
      ) : null}
    </div>
  );
}
