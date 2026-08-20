// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { getPublicMerchants } from "@/services/embed/queries";
import { requireCurrentFund } from "@/services/fund/server";
import { EmbedFrame, EmbedHeader } from "../../embed-header";
import { MerchantMapLoader } from "./merchant-map-loader";
import type { MapPin } from "./merchant-map";

// The same public directory as /embed/merchants, on a map. Coordinates are
// cached from CitizenPay when a merchant connects, so a fund that has just
// started onboarding will legitimately have merchants but no pins — partial
// coverage is the normal case, and an empty map gets a message rather than a
// view of the null island.

// Fallback accent when the fund hasn't set a brand colour — the platform
// terracotta from the root layout's theme-color.
const DEFAULT_PIN_COLOR = "#c46a4a";

export default function EmbedMerchantMapPage() {
  return (
    <Suspense fallback={<MapSkeleton />}>
      <MerchantMapWidget />
    </Suspense>
  );
}

async function MerchantMapWidget() {
  const fund = await requireCurrentFund();
  const merchants = await getPublicMerchants(fund.id);

  const locale = fund.defaultLocale;
  const t = await getTranslations({ locale, namespace: "embed" });

  const pins: MapPin[] = merchants
    .filter(
      (m): m is typeof m & { latitude: number; longitude: number } =>
        m.latitude !== null && m.longitude !== null,
    )
    .map((m) => ({
      id: m.id,
      name: m.name,
      address:
        [m.address, [m.postalCode, m.city].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", ") || null,
      website: m.website,
      latitude: m.latitude,
      longitude: m.longitude,
    }));

  return (
    <EmbedFrame primaryColor={fund.primaryColor}>
      <EmbedHeader fundName={fund.name} logoUrl={fund.logoUrl} />
      <div className="h-[380px] overflow-hidden rounded-lg border">
        {pins.length === 0 ? (
          <div className="flex size-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
            {t("map.empty")}
          </div>
        ) : (
          <MerchantMapLoader
            pins={pins}
            accentColor={fund.primaryColor ?? DEFAULT_PIN_COLOR}
            websiteLabel={t("merchants.website")}
            loadingLabel={t("map.loading")}
          />
        )}
      </div>
    </EmbedFrame>
  );
}

function MapSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <Skeleton className="size-6 rounded" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-[380px] w-full rounded-lg" />
    </div>
  );
}
