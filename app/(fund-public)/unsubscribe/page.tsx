// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { prisma } from "@/services/db/prisma";
import { verifyUnsubscribeToken } from "@/services/member/unsubscribe";
import { UnsubscribeToggle } from "./unsubscribe-toggle";

// Public opt-out landing for the deregistration link in member emails (issue
// #40). The token authenticates the member (HMAC), so no session is needed.
//
// Cache Components: the page shell is synchronous; all runtime data access
// (searchParams, getTranslations, DB) lives in an async child behind a
// <Suspense> boundary so `next build` stays green.

export default function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  return (
    <div className="w-full max-w-md">
      <Suspense fallback={<UnsubscribeSkeleton />}>
        <UnsubscribeContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function UnsubscribeContent({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getTranslations("unsubscribe");
  const { token } = await searchParams;

  const memberId = token ? verifyUnsubscribeToken(token) : null;
  const member = memberId
    ? await prisma.member.findUnique({
        where: { id: memberId },
        select: { firstName: true, emailUnsubscribed: true },
      })
    : null;

  if (!token || !member) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("errorTitle")}</CardTitle>
          <CardDescription>{t("errors.invalidLink")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>
          {t("description", { firstName: member.firstName })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <UnsubscribeToggle
          token={token}
          initialUnsubscribed={member.emailUnsubscribed}
        />
      </CardContent>
    </Card>
  );
}

function UnsubscribeSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-9 w-full" />
      </CardContent>
    </Card>
  );
}
