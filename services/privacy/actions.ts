// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { PRIVACY_COOKIE } from "@/lib/privacy";

const ONE_DAY_SECONDS = 60 * 60 * 24;

// Toggle privacy mode for this browser. Short-lived on purpose: a demo
// preference should not silently outlive the demo.
export async function setPrivacyMode(enabled: boolean) {
  const store = await cookies();
  if (enabled) {
    store.set(PRIVACY_COOKIE, "1", {
      path: "/",
      maxAge: ONE_DAY_SECONDS,
      sameSite: "lax",
    });
  } else {
    store.delete(PRIVACY_COOKIE);
  }
  revalidatePath("/", "layout");
}
