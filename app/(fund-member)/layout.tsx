// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { getCurrentFund } from "@/services/fund/server";
import { getHostType } from "@/services/host/server";

// Member pages (plan "Bread card-holder voting", PR W-1): a card holder's
// login at the fund that issued the card — /login, /signup, /forgot, /reset,
// /account on the FUND host. They live under /member/* and proxy.ts
// rewrites the short paths here for funds that opted in. Off a fund host, or
// at a fund with member login off, nothing exists: 404 (the proxy never
// rewrites there either; this is the defence in depth for a direct
// /member/* visit).
//
// No card pages: cards, PIN and the ballot are the wallet's
// (tap.citizenpay.eu), which logs the member in through the OAuth server.

export default async function FundMemberLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await getHostType()) !== "fund") notFound();
  const fund = await getCurrentFund();
  if (!fund?.memberLoginEnabled) notFound();
  const t = await getTranslations("memberLogin.shell");

  return (
    <main className="flex flex-1 flex-col items-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        {fund.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={fund.logoUrl}
            alt={fund.name}
            className="h-12 w-auto object-contain"
          />
        ) : (
          <span
            className="flex size-12 items-center justify-center rounded-full text-lg font-semibold text-white"
            style={{ backgroundColor: fund.primaryColor ?? "#1a1a1a" }}
            aria-hidden
          >
            {fund.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div>
          <div className="text-lg font-semibold tracking-tight">{fund.name}</div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("tagline")}
          </div>
        </div>
      </div>
      <div className="w-full max-w-md">{children}</div>
      <div className="mt-8 flex items-center gap-4 text-xs text-muted-foreground">
        <span>{t("poweredBy")}</span>
        <LocaleSwitcher />
      </div>
    </main>
  );
}
