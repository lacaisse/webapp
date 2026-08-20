// SPDX-License-Identifier: AGPL-3.0-or-later

// The <iframe> snippet an admin copies into their website. Shared by the
// server-rendered merchant cards and the client-rendered account rows, so it
// lives beside them as a plain module (no directive) rather than in either.

// Sensible starting heights per widget. The admin can edit them — the snippet
// is a starting point, not an API — but a default that fits the typical
// content saves everyone a round of trial and error.
export const EMBED_HEIGHTS = {
  account: 420,
  merchants: 600,
  map: 480,
} as const;

// Fund and account names are admin-authored free text and land inside a
// double-quoted HTML attribute, so quote-escape before interpolating.
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * `loading="lazy"` so a widget below the fold costs the visitor nothing until
 * they scroll to it, and a `title` because an iframe without one is an
 * unlabelled landmark for anyone using a screen reader.
 */
export function buildEmbedSnippet(
  src: string,
  title: string,
  height: number,
): string {
  return `<iframe src="${escapeAttribute(src)}" width="100%" height="${height}" style="border:0" loading="lazy" title="${escapeAttribute(title)}"></iframe>`;
}
