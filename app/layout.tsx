// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { DEFAULT_LOCALE } from "@/services/i18n/config";
import { HtmlLang } from "./html-lang";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/Geist-VariableFont.ttf",
  variable: "--font-sans",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-VariableFont.ttf",
  variable: "--font-geist-mono",
});

const fraunces = localFont({
  src: "./fonts/Fraunces-VariableFont.ttf",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "La caisse — Run a local solidarity food fund",
  description:
    "La caisse gives non-profits and community groups everything they need to manage members, allocate tokens, and pay partner merchants — under their own brand, on their own terms.",
};

// Platform terracotta. Hex equivalent of oklch(0.58 0.13 35) for the meta tag
// (browser theme-color support for oklch is still spotty as of 2026-05).
// Fund subdomains can override via a per-tenant viewport when fund branding
// is wired through to the root layout.
export const viewport: Viewport = {
  themeColor: "#c46a4a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // `lang` ships as the build-time default in the static shell (Cache
  // Components can't read the locale cookie at prerender) and is corrected to
  // the user's locale on the client by <HtmlLang />.
  return (
    <html
      lang={DEFAULT_LOCALE}
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* NextIntlClientProvider resolves the locale + messages from the
            request (cookie-based), which is runtime data. Under Cache
            Components that must sit inside a <Suspense> boundary so the
            document shell stays static; per-route boundaries below stream
            their own skeletons. */}
        <Suspense fallback={null}>
          <NextIntlClientProvider>
            <HtmlLang />
            {children}
          </NextIntlClientProvider>
        </Suspense>
      </body>
    </html>
  );
}
