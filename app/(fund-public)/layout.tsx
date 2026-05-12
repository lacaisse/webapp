import { notFound } from "next/navigation";
import { getHostType } from "@/services/host/server";

// Public fund-scoped pages (member signup, merchant signup, etc.).
// Distinguished from `(fund)` by NOT requiring auth — visitors can land
// here without an account. Still gated to fund subdomains: `lacaisse.eu`
// itself has no "signup to which fund?" context.

export default async function FundPublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await getHostType()) !== "fund") notFound();
  return (
    <main className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12">
      {children}
    </main>
  );
}
