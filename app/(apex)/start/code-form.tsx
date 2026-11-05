// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// "Enter your invite code": a plain GET form. The code goes into the URL
// (/join?code=…), the page checks it there, and the URL stays shareable and
// survives back/forward. Nothing to run in the browser — the server
// normalises whatever was typed (case, dashes, look-alike letters).
export async function CodeForm({ code, error }: { code?: string; error?: string }) {
  const t = await getTranslations("join");

  return (
    <form method="get" action="/join" className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="code">{t("code")}</Label>
        <Input
          id="code"
          name="code"
          defaultValue={code ?? ""}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          className="font-mono uppercase tracking-wider"
          aria-invalid={error ? true : undefined}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" className="w-full">
        {t("continue")}
      </Button>
    </form>
  );
}
