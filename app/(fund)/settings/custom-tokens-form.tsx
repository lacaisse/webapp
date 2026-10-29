// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition } from "react";

import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Label } from "@/components/ui/label";
import {
  addDisplayTokenAction,
  removeDisplayTokenAction,
} from "@/services/fund/settings-actions";
import type { CustomDisplayToken } from "@/services/token/display-tokens";

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Settings → Token, under the xDAI / EURe checkboxes: the ERC-20s this fund
// registered to show next to its fund token on the Accounts pages. Adding
// reads symbol / name / decimals from the contract server-side; the list
// comes back from the server (the actions revalidate /settings), removal
// hides the row optimistically.
export function CustomTokensForm({ tokens }: { tokens: CustomDisplayToken[] }) {
  const t = useTranslations("fund.settings.token.customTokens");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, startAdding] = useTransition();
  const [optimistic, hide] = useOptimistic(tokens, (rows, id: string) =>
    rows.filter((row) => row.id !== id),
  );

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = address.trim();
    if (!value) return;
    startAdding(async () => {
      const result = await addDisplayTokenAction({ address: value });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setAddress("");
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {optimistic.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {optimistic.map((tok) => (
            <li key={tok.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{tok.symbol}</span>
                  <span className="truncate text-muted-foreground">{tok.name}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-0.5">
                    <span className="font-mono" title={tok.address}>
                      {shortAddress(tok.address)}
                    </span>
                    <CopyButton value={tok.address} />
                  </span>
                  <span>{t("decimals", { decimals: tok.decimals })}</span>
                </div>
              </div>
              <RemoveTokenButton token={tok} onRemoved={hide} onError={setError} />
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onAdd} className="space-y-2">
        <Label htmlFor="custom-token-address">{t("address")}</Label>
        <div className="flex gap-2">
          <Input
            id="custom-token-address"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setError(null);
            }}
            placeholder={t("addressPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
            disabled={adding}
          />
          <Button type="submit" disabled={adding || address.trim() === ""}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />}
            {adding ? t("adding") : t("add")}
          </Button>
        </div>
      </form>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function RemoveTokenButton({
  token,
  onRemoved,
  onError,
}: {
  token: CustomDisplayToken;
  onRemoved: (id: string) => void;
  onError: (message: string | null) => void;
}) {
  const t = useTranslations("fund.settings.token.customTokens");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const onConfirm = () => {
    onError(null);
    startTransition(async () => {
      onRemoved(token.id);
      const result = await removeDisplayTokenAction({ id: token.id });
      setOpen(false);
      if ("error" in result) onError(result.error);
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("remove")}
            title={t("remove")}
          >
            <Trash2 className="text-muted-foreground" />
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("remove")}</DialogTitle>
          <DialogDescription>
            {t("confirmRemove", { symbol: token.symbol })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {t("remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
