// SPDX-License-Identifier: AGPL-3.0-or-later
// Paths proxy.ts passes through without classifying the host
// (docs/container.md): the health checks, and the routes the self-hosted
// runner calls straight on the container with the cron bearer. Pure, so the
// proxy and its tests share one list.

const PLATFORM_PATH_PREFIXES = ["/api/health/", "/api/internal/", "/api/maintenance/"];

export function isPlatformPath(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    PLATFORM_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}
