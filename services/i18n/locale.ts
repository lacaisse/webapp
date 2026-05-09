"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { isSupportedLocale, type SupportedLocale } from "./config";

const LOCALE_COOKIE = "locale";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function setLocale(locale: SupportedLocale) {
  if (!isSupportedLocale(locale)) return;
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}
