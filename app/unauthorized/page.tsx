import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import { logoutAction } from "../(auth)/actions";

export default async function UnauthorizedPage() {
  const t = await getTranslations();
  return (
    <div className="flex flex-1 items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("errors.unauthorizedTitle")}
          </h1>
          <p className="text-muted-foreground">
            {t("errors.unauthorizedDescription")}
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            {t("common.goHome")}
          </Link>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost">
              {t("common.signOut")}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
