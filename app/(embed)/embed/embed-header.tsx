// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared masthead for every widget: the fund's logo and name, so a visitor on
// a third-party page can see whose numbers these are.
//
// `primaryColor` is applied as an inline CSS custom property rather than a
// Tailwind class because it's per-fund runtime data — there is no class to
// generate at build time. Widgets read it as `var(--embed-accent)` and fall
// back to the app's own foreground colour when a fund hasn't set one.

export function EmbedHeader({
  fundName,
  logoUrl,
}: {
  fundName: string;
  logoUrl: string | null;
}) {
  return (
    <header className="flex items-center gap-2 border-b pb-2">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          className="size-6 rounded object-contain"
          width={24}
          height={24}
        />
      ) : null}
      <span className="text-sm font-medium">{fundName}</span>
    </header>
  );
}

/**
 * Wrapper every widget's root uses: sets the fund accent as a CSS variable and
 * gives the frame a consistent surface.
 */
export function EmbedFrame({
  primaryColor,
  children,
}: {
  primaryColor: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      className="space-y-3"
      style={
        primaryColor
          ? ({ "--embed-accent": primaryColor } as React.CSSProperties)
          : undefined
      }
    >
      {children}
    </div>
  );
}
