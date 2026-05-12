import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { PasskeysManager } from "./passkeys-manager";

export default async function PasskeysPage() {
  const user = await requireUser();
  const t = await getTranslations("account.passkeys");

  const passkeys = await prisma.passkey.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      deviceType: true,
      backedUp: true,
      createdAt: true,
    },
  });

  return (
    <div className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <PasskeysManager
              passkeys={passkeys.map((p) => ({
                ...p,
                createdAt: p.createdAt.toISOString(),
              }))}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
