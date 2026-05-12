import { redirect } from "next/navigation";

import { FundSidebar } from "@/components/fund-sidebar";
import { requireFundRole } from "@/services/auth/dal";
import { getApexUrl } from "@/services/fund/server";
import { getHostType } from "@/services/host/server";

// Fund admin shell: sidebar + main content. Pages in this group are scoped to
// a fund and require ADMIN (per the scoping doc — reporting and management
// are admin-only). Off a fund host these routes don't exist — bounce to the
// apex fund picker rather than preserving the path (which would just hit
// this same layout again and loop).

export default async function FundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await getHostType()) !== "fund") {
    redirect(getApexUrl("/"));
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
