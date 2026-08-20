// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Download } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type {
  PayoutExportPreset,
  PayoutExportRange,
} from "@/services/payout/export";

// Range picker + download link for the payout accounting export.
//
// The range lives in `?from`/`?to` so the URL is shareable and the server can
// re-render the "n payouts in this window" summary — a preset button just fills
// both params in one go. Local state mirrors the URL so the date inputs stay
// responsive while the navigation transition is in flight (the server's summary
// catches up a beat later); the download href is built from local state, so it
// always matches what the operator sees.
//
// The presets arrive pre-resolved from the server rather than being computed
// here, so the same clock decides the calendar boundaries for the markup and
// for the highlight — no `new Date()` on both sides of hydration.
//
// Two files come out of the same window, so there are two links: the
// *récapitulatif* (one row per payout, `/api/payouts/export`) and the *détail
// des transactions* (one row per order inside those payouts,
// `/api/payouts/export/orders`). The detail file is the heavier one — it costs
// CitizenPay one paginated call per payout — so the recap stays the primary
// button and the detail is the outline one beside it.
//
// The downloads themselves are plain <a>s to the fund-host route handlers, not
// server actions: Content-Disposition on a real navigation is what makes the
// browser save a file.
export function PayoutExportForm({
  from,
  to,
  count,
  presets,
}: {
  from: string;
  to: string;
  /** Payouts currently in range — 0 disables the download. */
  count: number;
  presets: ReadonlyArray<{ key: PayoutExportPreset; label: string } & PayoutExportRange>;
}) {
  const t = useTranslations("fund.payments.export");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [range, setRange] = useState<PayoutExportRange>({ from, to });
  const [pending, startTransition] = useTransition();

  function apply(next: PayoutExportRange) {
    setRange(next);
    const params = new URLSearchParams(searchParams);
    params.set("from", next.from);
    params.set("to", next.to);
    startTransition(() =>
      router.replace(`?${params.toString()}`, { scroll: false }),
    );
  }

  function setDay(key: "from" | "to", value: string) {
    apply({ ...range, [key]: value });
  }

  const valid = range.from !== "" && range.to !== "" && range.from <= range.to;
  const query = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const disabled = !valid || count === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => {
          const active = preset.from === range.from && preset.to === range.to;
          return (
            <Button
              key={preset.key}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              disabled={pending}
              onClick={() => apply({ from: preset.from, to: preset.to })}
            >
              {preset.label}
            </Button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="payout-export-from" className="text-xs">
            {t("from")}
          </Label>
          <Input
            id="payout-export-from"
            type="date"
            value={range.from}
            max={range.to || undefined}
            disabled={pending}
            onChange={(e) => setDay("from", e.target.value)}
            className="h-9 w-auto"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="payout-export-to" className="text-xs">
            {t("to")}
          </Label>
          <Input
            id="payout-export-to"
            type="date"
            value={range.to}
            min={range.from || undefined}
            disabled={pending}
            onChange={(e) => setDay("to", e.target.value)}
            className="h-9 w-auto"
          />
        </div>

        <DownloadLink
          href={`/api/payouts/export?${query}`}
          label={t("downloadRecap")}
          variant="default"
          disabled={disabled}
        />
        <DownloadLink
          href={`/api/payouts/export/orders?${query}`}
          label={t("downloadDetail")}
          variant="outline"
          disabled={disabled}
        />
      </div>

      {!valid && <p className="text-xs text-destructive">{t("rangeInvalid")}</p>}
    </div>
  );
}

// A disabled anchor isn't a thing, so render the button shape without the href
// when there's nothing to download.
function DownloadLink({
  href,
  label,
  variant,
  disabled,
}: {
  href: string;
  label: string;
  variant: "default" | "outline";
  disabled: boolean;
}) {
  if (disabled) {
    return (
      <span
        className={cn(buttonVariants({ variant }), "pointer-events-none opacity-50")}
        aria-disabled="true"
      >
        <Download className="size-4" />
        {label}
      </span>
    );
  }
  return (
    <a href={href} download className={buttonVariants({ variant })}>
      <Download className="size-4" />
      {label}
    </a>
  );
}
