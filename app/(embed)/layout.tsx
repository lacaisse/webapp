// SPDX-License-Identifier: AGPL-3.0-or-later

// Public embeddable widgets, rendered inside an <iframe> on the fund's own
// website. Its own route group rather than a corner of `(fund-public)`: that
// layout centres a padded card in a full-height viewport, which is the wrong
// shape for a 420px iframe.
//
// Deliberately bare — no chrome, no navigation, no locale switcher. The
// surrounding page is the fund's website and owns all of that; anything we add
// here shows up as a box-in-a-box on someone else's design.
//
// Synchronous on purpose. Under Cache Components any headers() read here would
// sit outside every <Suspense> boundary and force the whole group out of
// prerendering. The fund gate is not lost: each page calls requireCurrentFund()
// inside its async child, which 404s when the request carries no fund — i.e. on
// the apex, the auth host, and unknown hosts. proxy.ts strips inbound
// x-fund-id, so that header cannot be spoofed into existence.
//
// Which sites may frame these pages is enforced separately, by the
// `frame-ancestors` CSP proxy.ts emits from the fund's allowlist.

export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <main className="flex-1 p-3">{children}</main>;
}
