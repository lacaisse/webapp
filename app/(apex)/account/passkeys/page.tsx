// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

// Passkey management was folded into the consolidated security hub. Keep this
// route as a redirect so existing links / bookmarks still resolve.
export default function PasskeysPage() {
  redirect("/account/security");
}
