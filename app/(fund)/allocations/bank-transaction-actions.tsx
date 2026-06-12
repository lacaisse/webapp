// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  attributeBankTransactionAction,
  suggestMembersForAttributionAction,
  unlinkBankTransactionAction,
  type MemberSuggestion,
} from "@/services/bank-sync/admin-actions";

export function BankTransactionRowActions({
  bankTransactionId,
  isMatched,
}: {
  bankTransactionId: string;
  isMatched: boolean;
}) {
  if (isMatched) {
    return <UnlinkButton bankTransactionId={bankTransactionId} />;
  }
  return <AttributeDialog bankTransactionId={bankTransactionId} />;
}

// Search-and-pick member dialog for attributing an unmatched deposit. Also
// used on the allocation-period detail page — keep it self-contained (only
// needs the bank transaction id).
export function AttributeDialog({
  bankTransactionId,
}: {
  bankTransactionId: string;
}) {
  const t = useTranslations("fund.payments.admin.attribute");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<MemberSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Load suggestions when the dialog opens and whenever the query changes
  // (debounced). Empty query → name-ranked suggestions for this deposit.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      const results = await suggestMembersForAttributionAction({
        bankTransactionId,
        query,
      });
      if (!cancelled) {
        setSuggestions(results);
        setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, bankTransactionId]);

  const attribute = (memberId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await attributeBankTransactionAction({
        bankTransactionId,
        memberId,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery("");
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button variant="default" size="sm" />}>
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {loading ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t("loading")}
              </p>
            ) : suggestions.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {query.length >= 2 ? t("noResults") : t("noSuggestions")}
              </p>
            ) : (
              suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={pending}
                  onClick={() => attribute(s.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{s.name}</span>
                    {s.matchedSerial && (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {s.matchedSerial}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {!s.tierAssigned && (
                      <Badge variant="warning">{t("noTier")}</Badge>
                    )}
                    {!s.hasCardAccount && (
                      <Badge variant="warning">{t("noCard")}</Badge>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnlinkButton({ bankTransactionId }: { bankTransactionId: string }) {
  const t = useTranslations("fund.payments.admin.link");
  const [pending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(async () => {
      await unlinkBankTransactionAction({ bankTransactionId });
    });
  };

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      {pending ? t("unlinking") : t("unlinkButton")}
    </Button>
  );
}
