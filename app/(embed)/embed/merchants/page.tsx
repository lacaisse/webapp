// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { getPublicMerchants } from "@/services/embed/queries";
import { requireCurrentFund } from "@/services/fund/server";
import { EmbedFrame, EmbedHeader } from "../embed-header";

// Public merchant directory. No slug gate here: the data is already the fund's
// public directory (ACTIVE + publiclyVisible, the same rule the {shopList}
// email variable uses), so the only access control that matters is which sites
// may frame it — the `frame-ancestors` CSP from proxy.ts.

export default function EmbedMerchantsPage() {
  return (
    <Suspense fallback={<MerchantsSkeleton />}>
      <MerchantsWidget />
    </Suspense>
  );
}

async function MerchantsWidget() {
  const fund = await requireCurrentFund();
  const merchants = await getPublicMerchants(fund.id);

  const locale = fund.defaultLocale;
  const t = await getTranslations({ locale, namespace: "embed.merchants" });

  return (
    <EmbedFrame primaryColor={fund.primaryColor}>
      <EmbedHeader fundName={fund.name} logoUrl={fund.logoUrl} />

      <h1 className="text-xs font-medium text-muted-foreground">{t("title")}</h1>

      {merchants.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y">
          {merchants.map((m) => (
            <li key={m.id} className="flex gap-3 py-2.5">
              {m.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={m.logoUrl}
                  alt=""
                  className="size-10 shrink-0 rounded object-contain"
                  width={40}
                  height={40}
                />
              ) : null}
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium">{m.name}</div>
                {m.description ? (
                  <p className="text-xs text-muted-foreground">
                    {m.description}
                  </p>
                ) : null}
                {formatAddress(m) ? (
                  <p className="text-xs text-muted-foreground">
                    {formatAddress(m)}
                  </p>
                ) : null}
                {m.conditions ? (
                  <p className="text-xs">
                    <span className="text-muted-foreground">
                      {t("conditions")}:{" "}
                    </span>
                    {m.conditions}
                  </p>
                ) : null}
                {m.website ? (
                  <a
                    href={m.website}
                    // The widget is framed on the fund's site; a merchant link
                    // must escape the iframe rather than navigate inside it.
                    // noreferrer/noopener because these are third-party URLs.
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-xs underline underline-offset-2"
                    style={{ color: "var(--embed-accent, inherit)" }}
                  >
                    {t("website")}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </EmbedFrame>
  );
}

// "12 rue des Tanneurs, 1000 Bruxelles" from whichever parts the fund has.
function formatAddress(m: {
  address: string | null;
  postalCode: string | null;
  city: string | null;
}): string | null {
  const locality = [m.postalCode, m.city].filter(Boolean).join(" ");
  return [m.address, locality].filter(Boolean).join(", ") || null;
}

function MerchantsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <Skeleton className="size-6 rounded" />
        <Skeleton className="h-4 w-32" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex gap-3 py-1">
          <Skeleton className="size-10 shrink-0 rounded" />
          <div className="w-full space-y-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
