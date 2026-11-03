// SPDX-License-Identifier: AGPL-3.0-or-later

// One rule for every `return_to`-style value a page hands to
// `window.location`, `redirect()` or a `Location` header: it must stay on
// the origin the request was made to. A prefix check on "/" and "//" is not
// enough — browsers parse `/\evil.example/x` the way they parse
// `//evil.example/x` — so the value is resolved against the origin with the
// WHATWG parser (which applies the same backslash rule) and only its path
// and query survive, and only when the resolved origin is the same.

export function sameOriginPath(
  raw: string | null | undefined,
  origin: string,
  fallback: string,
): string {
  if (!raw) return fallback;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base.origin) return fallback;
  if (!url.pathname.startsWith("/")) return fallback;
  return `${url.pathname}${url.search}`;
}
