import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createSupabaseServerClient } from "@/services/auth/server";
import { ResetPasswordForm } from "./reset-form";

export default async function ResetPasswordPage() {
  // The PKCE callback exchanges the recovery code into a real session before
  // forwarding here. If the user lands here without a session (typed the URL
  // directly, or the link expired and was never exchanged), there's nothing
  // for `updateUser({ password })` to act on — bounce them to /forgot-password.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/forgot-password?error=link_invalid");

  const t = await getTranslations("auth.resetPassword");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ResetPasswordForm />
      </CardContent>
    </Card>
  );
}
