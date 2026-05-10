import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { FundSidebar } from "@/components/fund-sidebar";
import { requireFundRole } from "@/services/auth/dal";
import { getApexUrl } from "@/services/fund/server";
import { getHostType } from "@/services/host/server";

// Fund admin shell: sidebar + main content. Pages in this group are scoped to
// a fund and require ADMIN (per the scoping doc — reporting and management
// are admin-only). If a request lands here on the wrong host, bounce to the
// apex with the same path so deep links from a fund subdomain still resolve.

export default async function FundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await getHostType()) !== "fund") {
    const h = await headers();
    const path = h.get("x-pathname") ?? "/";
    const search = h.get("x-search") ?? "";
    redirect(getApexUrl(`${path}${search}`));
  }

  const { fund } = await requireFundRole("ADMIN");

  return (
    <div className="flex flex-1">
      <FundSidebar
        fundName={fund.name}
        fundDomain={fund.domain}
        apexUrl={getApexUrl("/")}
      />
      <main className="flex-1 bg-muted/40">
        <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
