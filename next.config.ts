// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Cache Components: data fetching is excluded from prerenders unless wrapped
  // in `use cache`. Each route paints a static (skeleton) shell immediately and
  // streams its dynamic content behind <Suspense>, so client-side navigation
  // feels instant. (We don't use the `unstable_instant` validation export: its
  // `static` mode can't pass here because every fund page reads the locale
  // cookie + fund-host headers, which are inherently runtime.)
  // See AGENTS.md / node_modules/next/dist/docs/.../instant-navigation.md.
  cacheComponents: true,
  // (16.3 dropped experimental.instantNavigationDevToolsToggle — the Instant
  // Navs panel now ships in Next DevTools without a flag.)

  // The PDF renderer (services/document/pdf.tsx) reads the Geist TTFs from
  // app/fonts at runtime via fs. Next's tracer can't see that dynamic read, so
  // include the files explicitly in the bundles that render letters (the
  // download route + the settings preview action) — otherwise production falls
  // back to Helvetica.
  outputFileTracingIncludes: {
    "/api/cards/[id]/onboarding-letter": ["./app/fonts/Geist-*.ttf"],
    "/(fund)/settings": ["./app/fonts/Geist-*.ttf"],
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
