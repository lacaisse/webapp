// SPDX-License-Identifier: AGPL-3.0-or-later
// This route only redirects to /account/security. The loading.tsx supplies the
// Suspense boundary Cache Components needs so the redirect (dynamic) doesn't
// block the static shell.
export default function Loading() {
  return null;
}
