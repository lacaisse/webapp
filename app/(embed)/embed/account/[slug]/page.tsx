// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { getPublicAccountEmbed } from "@/services/embed/queries";
import { requireCurrentFund } from "@/services/fund/server";
import { EmbedFrame, EmbedHeader } from "../../embed-header";

// Public account widget: one token account's balance and its recent activity,
// addressed by an unguessable slug the admin mints in settings. Disabling or
// rotating the slug 404s this page, which is what makes those the revocation
// controls for a URL already pasted into a website.
//
// Cache Components: sync default export, all runtime work in an async child
// behind <Suspense> (see app/(fund-public)/unsubscribe/page.tsx).

export default function EmbedAccountPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return (
    <Suspense fallback={<AccountSkeleton />}>
      <AccountWidget params={params} />
    </Suspense>
  );
}

async function AccountWidget({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const fund = await requireCurrentFund();
  const { slug } = await params;

  const data = await getPublicAccountEmbed(fund, slug);
  if (!data) notFound();

  // Visitors arrive from the fund's own website with no locale cookie of ours,
  // so the widget speaks the fund's configured language rather than negotiating.
  const locale = fund.defaultLocale;
  const t = await getTranslations({ locale, namespace: "embed.account" });
  const format = await getFormatter({ locale });

  return (
    <EmbedFrame primaryColor={fund.primaryColor}>
      <EmbedHeader fundName={fund.name} logoUrl={fund.logoUrl} />

      <section>
        <div className="text-xs text-muted-foreground">{t("balanceLabel")}</div>
        <div
          className="font-heading text-3xl font-medium"
          style={{ color: "var(--embed-accent, inherit)" }}
        >
          {data.balance === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <>
              {data.balance}
              {data.tokenSymbol ? (
                <span className="ml-1 text-base font-normal text-muted-foreground">
                  {data.tokenSymbol}
                </span>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section className="space-y-1.5">
        <h2 className="text-xs font-medium text-muted-foreground">
          {t("recentActivity")}
        </h2>

        {data.transfersError ? (
          <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
        ) : data.transfers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y">
            {data.transfers.map((tr, i) => (
              <li
                // No stable public id by design — the row carries no hash and
                // no uniqueId, so the index within this fixed-size list is the
                // key. The list never reorders or paginates.
                key={i}
                className="flex items-baseline justify-between gap-3 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">
                    {tr.counterparty ?? t(`kinds.${tr.kind}`)}
                  </div>
                  {tr.timestamp ? (
                    <div className="text-xs text-muted-foreground">
                      {format.dateTime(new Date(tr.timestamp), {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </div>
                  ) : null}
                </div>
                <div
                  className={
                    tr.direction === "in"
                      ? "text-sm font-medium text-emerald-600"
                      : "text-sm font-medium"
                  }
                >
                  {tr.direction === "in" ? "+" : tr.direction === "out" ? "−" : ""}
                  {tr.value}
                  {data.tokenSymbol ? ` ${data.tokenSymbol}` : ""}
                  <span className="sr-only">
                    {" "}
                    {tr.direction === "in" ? t("in") : t("out")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </EmbedFrame>
  );
}

function AccountSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <Skeleton className="size-6 rounded" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-9 w-40" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}
