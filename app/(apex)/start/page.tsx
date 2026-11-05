// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Image from "next/image";
import { permanentRedirect, redirect } from "next/navigation";

import { LocaleSwitcher } from "@/components/locale-switcher";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentUser } from "@/services/auth/dal";
import { getApexUrl } from "@/services/fund/server";
import { SUBSCRIPTION_MONTHLY_EUR } from "@/services/fund-setup/config";
import { lookupJoinCode } from "@/services/fund-setup/join";
import { getAuthUrl } from "@/services/host/server";

import { JoinForm, type JoinFormCode } from "./join-form";

// Public, reached as /join on the apex (proxy.ts rewrites it here — see
// APEX_JOIN_PATH there; the path itself is the member sign-up's on fund
// hosts). "Start your fund": anyone creates their account and their fund in
// one go; the dashboard's setup checklist then asks for the Citizen Pay
// registration, open banking and the hosting subscription. An invite code is
// the one extra — "I have an invite code" inside the form — and waives the
// subscription from the start; the door's rules are in
// services/fund-setup/join.ts.
//
// ?code= is a shared link (an admin hands the holder /join?code=…): the code
// is checked here, never consumed, and the form opens with the verdict. A
// signed-in visitor is sent to /new, where the fund goes on the account they
// have (the code along, as typed; /new checks it again).
//
// ?code= carries the invite code, so no Referer leaves this page.
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  // /join is the only public URL: a visit to /start itself (typed, or the
  // (apex) layout's cross-host bounce) is sent there for good. The proxy
  // forwards the public path, so the rewrite never trips this.
  const h = await headers();
  if (h.get("x-pathname") === "/start") permanentRedirect(`/join${h.get("x-search") ?? ""}`);

  const params = await searchParams;
  const raw = typeof params.code === "string" ? params.code.trim() : "";

  const user = await getCurrentUser();
  if (user) redirect(raw ? `/new?code=${encodeURIComponent(raw)}` : "/new");

  const [t, format] = await Promise.all([getTranslations("join"), getFormatter()]);
  const price = format.number(SUBSCRIPTION_MONTHLY_EUR, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });

  // Where the footer's "Sign in" comes back to: /new, with the code once it
  // checked out (the gate there accepts it).
  let initialCode: JoinFormCode | undefined;
  let newFundPath = "/new";
  if (raw) {
    const lookup = await lookupJoinCode(raw);
    if (lookup.kind === "ok") {
      initialCode = { value: lookup.code, label: lookup.label };
      newFundPath = `/new?code=${encodeURIComponent(lookup.code)}`;
    } else {
      initialCode = {
        value: raw,
        error: t(lookup.kind === "too_many" ? "errors.tooMany" : "errors.codeInvalid"),
      };
    }
  }
  const loginHref = getAuthUrl(
    `/login?return_to=${encodeURIComponent(getApexUrl(newFundPath))}`,
  );

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-muted/40 px-4 py-12">
      <Image
        src="/logo.png"
        alt="La caisse"
        width={80}
        height={62}
        priority
        className="mb-6 h-auto w-16"
      />
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description", { price })}</CardDescription>
          </CardHeader>
          <CardContent>
            <JoinForm initialCode={initialCode} />
          </CardContent>
          <CardFooter className="text-sm text-muted-foreground">
            <span>
              {t("haveAccount")}&nbsp;
              <a href={loginHref} className="text-foreground underline">
                {t("signIn")}
              </a>
            </span>
          </CardFooter>
        </Card>
      </div>
      <div className="mt-6">
        <LocaleSwitcher />
      </div>
    </div>
  );
}
