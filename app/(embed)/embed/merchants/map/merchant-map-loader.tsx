// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

import type { MapPin } from "./merchant-map";

// Leaflet reads `window` while its module initialises, so the map has to be
// browser-only. `ssr: false` is not allowed in a Server Component, hence this
// thin client wrapper between the page and the map itself.
//
// The dynamic() call sits at module scope on purpose: creating it inside the
// component would produce a new component type on every render and remount the
// map (losing pan/zoom) each time. The loading label is a prop, so the
// placeholder comes from a <Suspense> boundary here rather than dynamic's own
// `loading` option, which can't see props.
const MerchantMap = dynamic(() => import("./merchant-map"), { ssr: false });

export function MerchantMapLoader({
  pins,
  accentColor,
  websiteLabel,
  loadingLabel,
}: {
  pins: MapPin[];
  accentColor: string;
  websiteLabel: string;
  loadingLabel: string;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex size-full items-center justify-center bg-muted/40 text-sm text-muted-foreground">
          {loadingLabel}
        </div>
      }
    >
      <MerchantMap
        pins={pins}
        accentColor={accentColor}
        websiteLabel={websiteLabel}
      />
    </Suspense>
  );
}
