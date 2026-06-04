// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowUpRight,
  Coins,
  CreditCard,
  Gift,
  Landmark,
  LayoutDashboard,
  Mail,
  Receipt,
  Settings,
  Store,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { cn } from "@/lib/utils";

type Item = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

export function FundSidebar({
  fundName,
  fundDomain,
  apexUrl,
}: {
  fundName: string;
  fundDomain: string;
  apexUrl: string;
}) {
  const pathname = usePathname();
  const t = useTranslations("fund.nav");

  const items: Item[] = [
    { href: "/dashboard", label: t("dashboard"), icon: LayoutDashboard },
    { href: "/members", label: t("members"), icon: Users },
    { href: "/cards", label: t("cards"), icon: CreditCard },
    { href: "/allocations", label: t("allocations"), icon: Wallet },
    { href: "/token", label: t("token"), icon: Coins },
    { href: "/merchants", label: t("merchants"), icon: Store },
    { href: "/payments", label: t("payments"), icon: Receipt },
    { href: "/bank", label: t("bank"), icon: Landmark },
    { href: "/referrals", label: t("referrals"), icon: Gift },
    { href: "/emails", label: t("emails"), icon: Mail },
    { href: "/team", label: t("team"), icon: UserCog },
    { href: "/settings", label: t("settings"), icon: Settings },
  ];

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="flex flex-col gap-0.5 p-4">
        <div className="font-heading text-base font-medium">{fundName}</div>
        <div className="text-xs text-muted-foreground">{fundDomain}</div>
      </div>

      <nav className="flex-1 px-2">
        <ul className="space-y-0.5">
          {items.map(({ href, label, icon: Icon }) => {
            const isActive =
              pathname === href || pathname.startsWith(`${href}/`);
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex flex-col gap-2 border-t border-border p-3">
        <a
          href={apexUrl}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
        >
          <ArrowUpRight className="size-4" />
          {t("backToApex")}
        </a>
        <div className="px-2">
          <LocaleSwitcher />
        </div>
      </div>
    </aside>
  );
}
