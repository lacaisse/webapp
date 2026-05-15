// SPDX-License-Identifier: AGPL-3.0-or-later
import Image from "next/image";
import { notFound } from "next/navigation";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { getHostType } from "@/services/host/server";

// Auth flows live exclusively on `auth.<APP_DOMAIN>`. If a request lands here
// on the apex or a fund subdomain we 404 — login is centralized so cookies
// can be issued for whichever host the user is heading to (Google-style),
// and so passkeys (rpID = apex) work for custom-domain funds.

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await getHostType()) !== "auth") notFound();

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
      <div className="w-full max-w-sm">{children}</div>
      <div className="mt-6">
        <LocaleSwitcher />
      </div>
    </div>
  );
}
