// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { setMerchantVisibilityAction } from "@/services/merchant/admin-actions";

// Inline toggle for a merchant's public-directory visibility. Optimistic —
// flips locally first, reverts on a server error. Lives on the merchant
// detail page; hiding a merchant drops it from the {shopList} email variable.
export function MerchantVisibilityToggle({
  merchantId,
  initialVisible,
}: {
  merchantId: string;
  initialVisible: boolean;
}) {
  const t = useTranslations("merchants.admin.visibility");
  const [visible, setVisible] = useState(initialVisible);
  const [pending, startTransition] = useTransition();

  const onChange = (next: boolean) => {
    setVisible(next);
    startTransition(async () => {
      const result = await setMerchantVisibilityAction({
        merchantId,
        publiclyVisible: next,
      });
      if ("error" in result) setVisible(!next);
    });
  };

  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={visible}
        disabled={pending}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-input"
      />
      <span className="inline-flex items-center gap-1.5 text-sm">
        {visible ? (
          <>
            <Eye className="size-3.5 text-muted-foreground" />
            {t("visible")}
          </>
        ) : (
          <>
            <EyeOff className="size-3.5 text-warning" />
            {t("hidden")}
          </>
        )}
      </span>
    </label>
  );
}
