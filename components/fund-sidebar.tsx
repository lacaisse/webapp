// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowUpRight,
  Coins,
  CreditCard,
  Landmark,
  LayoutDashboard,
  Mail,
  Receipt,
  Settings,
  Store,
  UserCog,
  Users,
  Wallet,
  Wallet2,
} from "lucide-react";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { hasMinFundRole } from "@/services/auth/roles";
import type { FundRole } from "@/services/db/generated/enums";
import { cn } from "@/lib/utils";

type Item = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  // Minimum fund role required to see (and use) this link. Cards + members are
  // OPERATOR-visible; everything else is ADMIN-only.
  minRole: FundRole;
};

export function FundSidebar({
  fundName,
  fundDomain,
  apexUrl,
  role,
}: {
  fundName: string;
  fundDomain: string;
  apexUrl: string;
  role: FundRole;
}) {
  const pathname = usePathname();
  const t = useTranslations("fund.nav");

  const allItems: Item[] = [
    { href: "/dashboard", label: t("dashboard"), icon: LayoutDashboard, minRole: "ADMIN" },
    { href: "/members", label: t("members"), icon: Users, minRole: "OPERATOR" },
    { href: "/cards", label: t("cards"), icon: CreditCard, minRole: "OPERATOR" },
    { href: "/allocations", label: t("allocations"), icon: Wallet, minRole: "ADMIN" },
    { href: "/token", label: t("token"), icon: Coins, minRole: "ADMIN" },
    { href: "/accounts", label: t("accounts"), icon: Wallet2, minRole: "ADMIN" },
    { href: "/merchants", label: t("merchants"), icon: Store, minRole: "ADMIN" },
    { href: "/payments", label: t("payments"), icon: Receipt, minRole: "ADMIN" },
    { href: "/bank", label: t("bank"), icon: Landmark, minRole: "ADMIN" },
    // Referrals hidden for now — re-add this item to restore the nav link.
    { href: "/emails", label: t("emails"), icon: Mail, minRole: "ADMIN" },
    { href: "/team", label: t("team"), icon: UserCog, minRole: "ADMIN" },
    { href: "/settings", label: t("settings"), icon: Settings, minRole: "ADMIN" },
  ];

  const items = allItems.filter((item) => hasMinFundRole(role, item.minRole));

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
