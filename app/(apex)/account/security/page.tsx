// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
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
import { ChangePasswordCard } from "./change-password-card";
import { PasskeysManager } from "./passkeys-manager";

export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <ChangePasswordCard />
      <Suspense fallback={<PasskeysCardSkeleton />}>
        <PasskeysCard />
      </Suspense>
    </div>
  );
}

async function PasskeysCard() {
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
  );
}

function PasskeysCardSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <span className="block h-5 w-40 animate-pulse rounded bg-muted" />
        <span className="block h-3.5 w-64 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <span key={i} className="block h-10 animate-pulse rounded bg-muted" />
        ))}
      </CardContent>
    </Card>
  );
}
