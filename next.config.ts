// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
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
