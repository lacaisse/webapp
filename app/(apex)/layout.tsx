import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getApexUrl } from "@/services/fund/server";
import { getHostType } from "@/services/host/server";

// Pages in this group (account settings, the create-fund flow, etc.) are
// account-level — they don't belong on a fund subdomain or on the auth host.
// If a request lands here on the wrong host, bounce to the apex with the
// same path. Preserves the URL so a deep link from a fund subdomain still
// lands in the right place after the cross-host hop.

export default async function ApexLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await getHostType()) !== "apex") {
    const h = await headers();
    const path = h.get("x-pathname") ?? "/";
    const search = h.get("x-search") ?? "";
    redirect(getApexUrl(`${path}${search}`));
  }
  return <>{children}</>;
}
