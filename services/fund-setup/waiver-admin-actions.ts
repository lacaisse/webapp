// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/services/auth/dal";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";

import {
  CreateWaiverCodeSchema,
  WAIVER_EXPIRES_DAYS_MAX,
  WAIVER_LABEL_MAX,
  WAIVER_LABEL_MIN,
  WAIVER_MAX_USES_MAX,
  type CreateWaiverCodeInput,
} from "./schema";
import { formatWaiverCode, generateWaiverCode } from "./waiver-codes";

// Apex /admin/waivers — platform admins (User.globalRole ADMIN) mint and
// revoke subscription waiver codes. A fund OWNER redeems one on
// Settings → Subscription (admin-actions.ts::redeemWaiverCodeAction).

export type CreateWaiverCodeResult =
  | { ok: true; id: string; code: string } // code formatted for handing over
  | { error: string };

const MINT_ATTEMPTS = 5;

export async function createWaiverCodeAction(
  input: CreateWaiverCodeInput,
): Promise<CreateWaiverCodeResult> {
  const user = await requireAdmin();

  const parsed = CreateWaiverCodeSchema.safeParse(input);
  if (!parsed.success) {
    const t = await getTranslations();
    return {
      error: t(parsed.error.issues[0].message as never, {
        min: WAIVER_LABEL_MIN,
        max: WAIVER_LABEL_MAX,
        maxUses: WAIVER_MAX_USES_MAX,
        maxDays: WAIVER_EXPIRES_DAYS_MAX,
      } as never),
    };
  }
  const { label, maxUses, expiresInDays } = parsed.data;
  const expiresAt =
    expiresInDays == null ? null : new Date(Date.now() + expiresInDays * 86_400_000);

  // ~60 random bits make a collision practically impossible; the unique
  // index is still the truth, so a clash just mints again.
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const code = generateWaiverCode();
    try {
      const row = await prisma.subscriptionWaiverCode.create({
        data: { code, label, maxUses, expiresAt, createdByUserId: user.id },
        select: { id: true, code: true },
      });
      revalidatePath("/admin/waivers");
      return { ok: true, id: row.id, code: formatWaiverCode(row.code) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      throw e;
    }
  }
  throw new Error("waiver code: could not mint a unique code");
}

export type RevokeWaiverCodeResult = { ok: true } | { error: string };

// Revoking closes the code for new redemptions; funds that already redeemed
// it stay waived (the waiver is the fund's, the code was only the door).
export async function revokeWaiverCodeAction(id: string): Promise<RevokeWaiverCodeResult> {
  await requireAdmin();
  const { count } = await prisma.subscriptionWaiverCode.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) {
    const exists = await prisma.subscriptionWaiverCode.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      const t = await getTranslations("admin.waivers.errors");
      return { error: t("notFound") };
    }
  }
  revalidatePath("/admin/waivers");
  return { ok: true };
}
