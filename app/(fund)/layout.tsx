// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

import { FundSidebar } from "@/components/fund-sidebar";
import { requireFundRole } from "@/services/auth/dal";
import { getApexUrl } from "@/services/fund/server";
import { getHostType } from "@/services/host/server";

// Fund admin shell: sidebar + main content. Entry requires at least OPERATOR
// (cards + members manager); each page self-guards beyond that — ADMIN-only
// pages call requireFundRole("ADMIN"), and the sidebar hides links the role
// can't use. Off a fund host these routes don't exist — bounce to the apex
// fund picker rather than preserving the path (which would just hit this same
// layout again and loop).

export default async function FundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await getHostType()) !== "fund") {
    redirect(getApexUrl("/"));
  }

  const { fund, membership } = await requireFundRole("OPERATOR");

  return (
    <div className="flex flex-1">
      <FundSidebar
        fundName={fund.name}
        fundDomain={fund.domain}
        apexUrl={getApexUrl("/")}
        role={membership.role}
      />
      <main className="flex-1 bg-muted/40">
        <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
