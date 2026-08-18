// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";

import "leaflet/dist/leaflet.css";

// The actual Leaflet map. Loaded only in the browser (see merchant-map-loader)
// because Leaflet touches `window` at import time.
//
// Strings arrive already translated: this renders under the fund's configured
// locale, which the server resolved — a client component here would otherwise
// re-negotiate from the visitor's own cookie and disagree with the rest of the
// widget.

export type MapPin = {
  id: string;
  name: string;
  address: string | null;
  website: string | null;
  latitude: number;
  longitude: number;
};

// OpenStreetMap's tile usage policy requires visible attribution. Raster tiles
// need no API key, which is the whole reason for this stack.
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// A div-based marker rather than Leaflet's default icon: the default pulls its
// PNGs from paths relative to the CSS, which every bundler rewrites and breaks.
// An inline SVG also lets the pin carry the fund's accent colour.
function pinIcon(color: string): L.DivIcon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="${color}" stroke="white" stroke-width="1.5"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5" fill="white" stroke="none"/></svg>`;
  return L.divIcon({
    html: svg,
    className: "", // suppress Leaflet's default white square
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -26],
  });
}

export default function MerchantMap({
  pins,
  accentColor,
  websiteLabel,
}: {
  pins: MapPin[];
  accentColor: string;
  websiteLabel: string;
}) {
  const icon = pinIcon(accentColor);

  // One pin has no meaningful extent to fit, so centre on it at street zoom.
  // Several get a fitted bounding box with padding so no pin sits on the edge.
  const single = pins.length === 1 ? pins[0] : null;
  const bounds = single
    ? undefined
    : (pins.map((p) => [p.latitude, p.longitude]) as [number, number][]);

  return (
    <MapContainer
      {...(single
        ? { center: [single.latitude, single.longitude] as [number, number], zoom: 15 }
        : { bounds, boundsOptions: { padding: [24, 24] as [number, number] } })}
      // Scroll-wheel zoom is off on purpose: the map is embedded mid-page on
      // someone else's site, and capturing the wheel would trap the visitor's
      // scroll. Drag and the +/- control still work.
      scrollWheelZoom={false}
      className="size-full"
    >
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
      {pins.map((p) => (
        <Marker key={p.id} position={[p.latitude, p.longitude]} icon={icon}>
          <Popup>
            <div className="space-y-0.5">
              <div className="font-medium">{p.name}</div>
              {p.address ? <div>{p.address}</div> : null}
              {p.website ? (
                <a
                  href={p.website}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {websiteLabel}
                </a>
              ) : null}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
