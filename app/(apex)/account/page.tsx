// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

// Account home — there's a single section today (security), so send there.
export default function AccountPage() {
  redirect("/account/security");
}
