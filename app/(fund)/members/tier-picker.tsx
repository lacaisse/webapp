// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTransition } from "react";

import { assignTierAction } from "@/services/member/admin-tier-actions";

export function MemberTierPicker({
  memberId,
  currentTierId,
  tiers,
}: {
  memberId: string;
  currentTierId: string | null;
  tiers: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();

  const onChange = (value: string) => {
    startTransition(async () => {
      await assignTierAction({
        memberId,
        tierId: value === "" ? null : value,
      });
    });
  };

  return (
    <select
      defaultValue={currentTierId ?? ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={pending}
      className="h-7 rounded-md bg-background px-2 text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <option value="">—</option>
      {tiers.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
