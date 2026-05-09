import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./server";

export const getCurrentUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export const requireUser = cache(async () => {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
});

export const requireAdmin = cache(async () => {
  const user = await requireUser();
  // Roles live in `app_metadata` because only the service role can write it
  // (`user_metadata` is user-writable and therefore unsafe for authz).
  const role = (user.app_metadata as { role?: string } | null)?.role;
  if (role !== "admin") redirect("/unauthorized");
  return user;
});
