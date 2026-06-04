// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { acceptFundInviteAction } from "@/services/fund-team/admin-actions";

// Accept happens via a POST-style server action (not on GET) so visiting the
// link never mutates. On success the action redirects to /dashboard.
export function AcceptButton({ token }: { token: string }) {
  const t = useTranslations("joinTeam");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onAccept = () => {
    setError(null);
    startTransition(async () => {
      const result = await acceptFundInviteAction({ token });
      // Reaches here only on failure — success redirects server-side.
      if (result && "error" in result) setError(result.error);
    });
  };

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button onClick={onAccept} disabled={pending} className="w-full">
        {pending ? t("accepting") : t("accept")}
      </Button>
    </div>
  );
}
