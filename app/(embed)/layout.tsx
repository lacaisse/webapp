// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from "next/navigation";
import { getHostType } from "@/services/host/server";

// Public embeddable widgets, rendered inside an <iframe> on the fund's own
// website. Its own route group rather than a corner of `(fund-public)`: that
// layout centres a padded card in a full-height viewport, which is the right
// shape for a signup page and the wrong one for a 420px-tall frame.
//
// Deliberately bare — no chrome, no navigation, no locale switcher. The
// surrounding page is the fund's website and owns all of that; anything we add
// here shows up as a box-in-a-box on someone else's design.
//
// Fund hosts only, like every other fund-scoped surface. Which sites may frame
// these pages is enforced separately, by the `frame-ancestors` CSP proxy.ts
// emits from the fund's allowlist.

export default async function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await getHostType()) !== "fund") notFound();
  return <main className="flex-1 p-3">{children}</main>;
}
