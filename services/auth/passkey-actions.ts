"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

export type PasskeyActionResult = { error: string } | { ok: true };

export async function deletePasskeyAction(
  credentialId: string,
): Promise<PasskeyActionResult> {
  const t = await getTranslations("account.passkeys.errors");
  const user = await requireUser();

  const credential = await prisma.webAuthnCredential.findUnique({
    where: { id: credentialId },
    select: { userId: true },
  });
  if (!credential) return { error: t("notFound") };
  if (credential.userId !== user.id) return { error: t("notAllowed") };

  await prisma.webAuthnCredential.delete({ where: { id: credentialId } });
  revalidatePath("/account/passkeys");
  return { ok: true };
}
