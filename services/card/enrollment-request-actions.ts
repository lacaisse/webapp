// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import {
  acceptCardEnrollmentRequest,
  cancelCardEnrollmentRequest,
  rejectCardEnrollmentRequest,
} from "@/services/card/enrollment-requests";

// Cross-fund card enrollment requests (see ./enrollment-requests.ts). Card
// management is an OPERATOR+ concern, like the rest of the card actions. The
// current fund is the issuer for accept/reject and the requester for cancel —
// never a fund id taken from input.

type ActionResult = { ok: true } | { error: string };

async function errorResult(code: string): Promise<{ error: string }> {
  const t = await getTranslations();
  return { error: t(`cards.admin.enrollmentRequest.errors.${code}` as never) };
}

export async function acceptCardEnrollmentRequestAction(input: {
  requestId: string;
}): Promise<ActionResult> {
  const { fund, user } = await requireFundRole("OPERATOR");
  let res;
  try {
    res = await acceptCardEnrollmentRequest({
      requestId: input.requestId,
      issuerFundId: fund.id,
      decidedById: user.id,
    });
  } catch (e) {
    console.error("[card-enrollment] accept action failed", e);
    return errorResult("failed");
  }
  if ("error" in res) return errorResult(res.error);
  revalidatePath("/cards");
  return { ok: true };
}

export async function rejectCardEnrollmentRequestAction(input: {
  requestId: string;
}): Promise<ActionResult> {
  const { fund, user } = await requireFundRole("OPERATOR");
  let res;
  try {
    res = await rejectCardEnrollmentRequest({
      requestId: input.requestId,
      issuerFundId: fund.id,
      decidedById: user.id,
    });
  } catch (e) {
    console.error("[card-enrollment] reject action failed", e);
    return errorResult("failed");
  }
  if ("error" in res) return errorResult(res.error);
  revalidatePath("/cards");
  return { ok: true };
}

export async function cancelCardEnrollmentRequestAction(input: {
  requestId: string;
}): Promise<ActionResult> {
  const { fund } = await requireFundRole("OPERATOR");
  let res;
  try {
    res = await cancelCardEnrollmentRequest({
      requestId: input.requestId,
      requesterFundId: fund.id,
    });
  } catch (e) {
    console.error("[card-enrollment] cancel action failed", e);
    return errorResult("failed");
  }
  if ("error" in res) return errorResult(res.error);
  revalidatePath("/cards");
  return { ok: true };
}
