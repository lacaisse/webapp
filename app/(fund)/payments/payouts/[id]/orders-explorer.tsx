// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PayoutOrder } from "@/services/citizenpay/types";
import { checkPayoutReceiptsAction } from "@/services/payout/admin-actions";
import { cn } from "@/lib/utils";

import { OrderReconcileActions } from "./order-reconcile-actions";

type OrderStatus = "checking" | "confirmed" | "unconfirmed";

// CP order status → badge variant. `paid` is the happy path; refunds get a
// warning tint, anything else stays neutral.
function orderStatusVariant(
  status: string,
): "success" | "warning" | "outline" {
  if (status === "paid") return "success";
  if (status === "refund" || status === "refunded") return "warning";
  return "outline";
}

// How many hashes per server-action round-trip. Small batches keep progress
// granular and stay under the bundler's rate limits (the action also batches
// internally).
const CHUNK = 8;

export function OrdersExplorer({
  orders,
  placeAccount,
  symbol,
  reconcilable,
  settled,
  payoutId,
}: {
  orders: PayoutOrder[];
  placeAccount: string | null;
  symbol: string | null;
  reconcilable: boolean;
  settled: boolean;
  payoutId: string;
}) {
  const t = useTranslations("fund.payments.settlement");
  const format = useFormatter();
  const [tab, setTab] = useState<"orders" | "issues">("orders");

  // Hashes we need to verify on-chain. Once the payout leaves `pending`
  // (settlement started), the orders are locked in — nothing to re-check.
  const toCheck = useMemo(
    () =>
      settled ? [] : orders.filter((o) => o.status === "paid" && !!o.txHash),
    [orders, settled],
  );

  // Orders the operator just fixed/archived — optimistically marked so the
  // row shows "Reconciling…" instead of the actions until the server
  // revalidation catches up, preventing a double-click (and double-mint).
  const [reconciled, setReconciled] = useState<Set<number>>(new Set());
  const markReconciled = (id: number) =>
    setReconciled((prev) => new Set(prev).add(id));

  const [statuses, setStatuses] = useState<Record<number, OrderStatus>>(() => {
    const initial: Record<number, OrderStatus> = {};
    for (const o of orders) {
      initial[o.id] = settled
        ? "confirmed"
        : o.status === "paid" && o.txHash
          ? "checking"
          : "unconfirmed";
    }
    return initial;
  });
  const [checked, setChecked] = useState(0);

  // Verify progressively, one small batch at a time, updating the UI after
  // each batch resolves.
  useEffect(() => {
    if (toCheck.length === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < toCheck.length; i += CHUNK) {
        const batch = toCheck.slice(i, i + CHUNK);
        let res: Record<string, string> = {};
        try {
          res = await checkPayoutReceiptsAction({
            hashes: batch.map((o) => o.txHash as string),
          });
        } catch {
          // Treat a failed batch as unverified rather than stalling.
        }
        if (cancelled) return;
        setStatuses((prev) => {
          const next = { ...prev };
          for (const o of batch) {
            next[o.id] =
              res[o.txHash as string] === "success"
                ? "confirmed"
                : "unconfirmed";
          }
          return next;
        });
        setChecked((c) => c + batch.length);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toCheck]);

  const confirmed = orders.filter((o) => statuses[o.id] === "confirmed");
  const issues = orders.filter((o) => statuses[o.id] === "unconfirmed");
  const verifying = checked < toCheck.length;
  const isIssues = tab === "issues";
  const active = isIssues ? issues : confirmed;
  const showActions = isIssues && reconcilable;
  const colCount = showActions ? 6 : 5;

  const euro = (v: string) =>
    format.number(Number(v), { style: "currency", currency: "EUR" });

  const pct =
    toCheck.length > 0 ? Math.round((checked / toCheck.length) * 100) : 0;

  return (
    <div className="space-y-3">
      {verifying && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" />
              {t("orders.verifyingLabel")}
            </span>
            <span className="tabular-nums">
              {checked} / {toCheck.length} ({pct}%)
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      <div
        role="tablist"
        className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-sm"
      >
        <TabButton active={!isIssues} onClick={() => setTab("orders")}>
          {t("orders.tabConfirmed")} ({confirmed.length})
        </TabButton>
        <TabButton active={isIssues} onClick={() => setTab("issues")}>
          {t("orders.tabIssues")} ({issues.length})
        </TabButton>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("orders.id")}</TableHead>
            <TableHead>{t("orders.date")}</TableHead>
            <TableHead>{t("orders.orderStatus")}</TableHead>
            <TableHead className="text-right">{t("fees")}</TableHead>
            <TableHead className="text-right">{t("orders.amount")}</TableHead>
            {showActions && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {active.length === 0 ? (
            <TableEmpty colSpan={colCount}>
              {verifying
                ? t("orders.verifyingEmpty")
                : isIssues
                  ? t("orders.issuesEmpty")
                  : t("orders.empty")}
            </TableEmpty>
          ) : (
            active.map((o) => {
              const hasDetail = Boolean(o.description) || o.items.length > 0;
              return (
                <Fragment key={o.id}>
                  <TableRow className={hasDetail ? "border-b-0" : undefined}>
                    <TableCell className="font-mono text-xs">{o.id}</TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {o.completedAt
                        ? format.dateTime(new Date(o.completedAt), {
                            dateStyle: "medium",
                          })
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={orderStatusVariant(o.status)}
                        className="capitalize"
                      >
                        {o.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {euro(o.fees)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {euro(o.total)}
                    </TableCell>
                    {showActions && (
                      <TableCell className="text-right">
                        {reconciled.has(o.id) ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" />
                            {t("reconcile.pending")}
                          </span>
                        ) : (
                          <OrderReconcileActions
                            payoutId={payoutId}
                            orderId={o.id}
                            account={o.account}
                            placeAccount={placeAccount}
                            total={o.total}
                            net={o.net}
                            symbol={symbol}
                            onReconciled={() => markReconciled(o.id)}
                          />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                  {hasDetail && (
                    <TableRow>
                      <TableCell colSpan={colCount} className="pt-0">
                        <div className="space-y-1 pl-2 text-sm">
                          {o.description && (
                            <p className="text-muted-foreground">
                              {o.description}
                            </p>
                          )}
                          {o.items.length > 0 && (
                            <ul className="space-y-0.5">
                              {o.items.map((it, i) => (
                                <li
                                  key={i}
                                  className="font-mono text-xs text-muted-foreground"
                                >
                                  {formatItem(it)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center rounded-md px-3 font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// Line-items have no fully-documented shape; prefer the human-readable
// `name` (with quantity when >1), falling back to compact `key: value`
// pairs for anything unexpected.
function formatItem(item: unknown): string {
  if (item == null) return "—";
  if (typeof item === "string" || typeof item === "number") return String(item);
  if (typeof item === "object") {
    const o = item as Record<string, unknown>;
    if (typeof o.name === "string" && o.name) {
      const qty = typeof o.quantity === "number" ? o.quantity : null;
      return qty && qty > 1 ? `${qty}× ${o.name}` : o.name;
    }
    const pairs = Object.entries(o)
      .filter(([, v]) => v != null && typeof v !== "object")
      .map(([k, v]) => `${k}: ${String(v)}`);
    return pairs.length ? pairs.join(" · ") : JSON.stringify(item);
  }
  return String(item);
}
