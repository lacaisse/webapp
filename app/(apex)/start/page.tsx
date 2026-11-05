// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { permanentRedirect, redirect } from "next/navigation";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { lookupJoinCode } from "@/services/fund-setup/join";
import { getAuthUrl } from "@/services/host/server";

import { CodeForm } from "./code-form";
import { JoinForm } from "./join-form";

// Public, reached as /join on the apex (proxy.ts rewrites it here — see
// APEX_JOIN_PATH there; the path itself is the member sign-up's on fund
// hosts). A person who holds a subscription waiver code creates their account
// and their fund in one go, waived from the start; the door's rules are in
// services/fund-setup/join.ts.
//
// Three states, all from the URL so back/forward and a shared link work:
// no code → the code field; a code that doesn't check out → the field with
// the (deliberately vague) reason; a usable code → the account + fund form.
// A signed-in visitor with a usable code is sent to /new?code=, where the
// gate accepts the code and the fund is created on the account they have.
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
  const t = await getTranslations("join");

  let body: React.ReactNode;
  // Where the footer's "Sign in" comes back to: /new with the code once it
  // checked out (the gate there accepts it), the apex otherwise.
  let returnTo = getApexUrl("/");

  if (!raw) {
    body = <CodeForm />;
  } else {
    const lookup = await lookupJoinCode(raw);
    if (lookup.kind === "ok") {
      const newFundPath = `/new?code=${encodeURIComponent(lookup.code)}`;
      const user = await getCurrentUser();
      if (user) redirect(newFundPath);
      returnTo = getApexUrl(newFundPath);
      body = (
        <div className="space-y-5">
          <Alert>
            <AlertDescription>{t("codeAccepted", { label: lookup.label })}</AlertDescription>
          </Alert>
          <JoinForm code={lookup.code} />
          <p className="text-center text-sm">
            <Link href="/join" className="text-muted-foreground underline">
              {t("changeCode")}
            </Link>
          </p>
        </div>
      );
    } else {
      body = (
        <CodeForm
          code={raw}
          error={t(lookup.kind === "too_many" ? "errors.tooMany" : "errors.codeInvalid")}
        />
      );
    }
  }

  const loginHref = getAuthUrl(`/login?return_to=${encodeURIComponent(returnTo)}`);

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
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent>{body}</CardContent>
          <CardFooter className="text-sm text-muted-foreground">
            {t("haveAccount")}&nbsp;
            <a href={loginHref} className="text-foreground underline">
              {t("signIn")}
            </a>
          </CardFooter>
        </Card>
      </div>
      <div className="mt-6">
        <LocaleSwitcher />
      </div>
    </div>
  );
}
